import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type LeadPurchase } from "@prisma/client";
import { Db } from "./prisma";
import { LeadDto, LeadReviewDto, ProductDto, SellerProfileDto } from "./dto";
import { assertLeadAvailable } from "./lead-rules";
@Injectable()
export class MarketplaceService {
  constructor(@Inject(Db) private db: Db) {}
  async profile(
    userId: string,
    dto: SellerProfileDto,
    client: Prisma.TransactionClient = this.db,
  ) {
    const { categoryIds, ...data } = dto;
    const free = await client.plan.findUnique({ where: { name: "Free" } });
    return client.seller.upsert({
      where: { userId },
      create: {
        userId,
        ...data,
        planId: free?.id,
        categories: {
          create: categoryIds.map((categoryId) => ({ categoryId })),
        },
      },
      update: {
        ...data,
        categories: {
          deleteMany: {},
          create: categoryIds.map((categoryId) => ({ categoryId })),
        },
      },
    });
  }
  async addProduct(userId: string, dto: ProductDto, id?: string) {
    return this.db.$transaction(async (tx) => {
      const seller = await tx.seller.findUnique({
        where: { userId },
        include: { plan: true, categories: true },
      });
      if (!seller)
        throw new BadRequestException("Complete your supplier profile");
      await tx.$queryRaw`SELECT id FROM "Seller" WHERE id = ${seller.id} FOR UPDATE`;
      const used = await tx.product.count({
        where: { sellerId: seller.id, active: true },
      });
      const activePlan =
        seller.subscriptionExpiresAt &&
        seller.subscriptionExpiresAt > new Date();
      const free = await tx.plan.findUnique({ where: { name: "Free" } });
      const limit = activePlan
        ? (seller.plan?.listingLimit ?? 5)
        : (free?.listingLimit ?? 5);
      if (used >= limit)
        throw new ConflictException("Plan listing limit reached");
      if (!seller.categories.some((c) => c.categoryId === dto.categoryId))
        throw new ForbiddenException(
          "Product category must match your business",
        );
      return tx.product.create({
        data: { ...dto, ...(id ? { id } : {}), sellerId: seller.id },
      });
    });
  }
  async createLead(userId: string, dto: LeadDto, id?: string) {
    const category = await this.db.category.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) throw new BadRequestException("Unknown category");
    return this.db.lead.create({
      data: {
        ...dto,
        ...(id ? { id } : {}),
        buyerId: userId,
        requiredBy: new Date(dto.requiredBy),
        price: category.leadPrice,
      },
    });
  }
  async leads(userId: string) {
    const seller = await this.db.seller.findUnique({
      where: { userId },
      include: { categories: true },
    });
    if (!seller) return [];
    const leads = await this.db.lead.findMany({
      where: {
        OR: [
          {
            ...(seller.categories.length ? { categoryId: { in: seller.categories.map((c) => c.categoryId) } } : {}),
            deletedAt: null,
            status: { in: ["ACTIVE", "PARTIALLY_SOLD"] },
          },
          { purchases: { some: { sellerId: seller.id } } },
        ],
      },
      include: {
        _count: { select: { purchases: true } },
        purchases: { where: { sellerId: seller.id }, select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(
      leads.map(async (l) => {
        const { buyerId, purchases, _count, documentIds, ...safe } = l;
        const contact = purchases.length
          ? await this.db.user.findUnique({
              where: { id: buyerId },
              select: { name: true, email: true, phone: true },
            })
          : undefined;
        return {
          ...safe,
          sold: _count.purchases,
          slotsRemaining: Math.max(0, l.maxSlots - _count.purchases),
          unlocked: !!purchases.length,
          documentIds: purchases.length ? documentIds : [],
          ...(contact ? { contact } : {}),
        };
      }),
    );
  }
  async unlock(
    userId: string,
    leadId: string,
    paymentId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<LeadPurchase> {
    if (!tx)
      return this.db.$transaction((client) =>
        this.unlock(userId, leadId, paymentId, client),
      );
    const lead = await tx.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException();
    // Row locks serialize purchases across all API processes, including webhook fulfilment.
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
    const fresh = await tx.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: { purchases: true },
    });
    if (fresh.deletedAt) throw new ConflictException("Lead is unavailable");
    const seller = await tx.seller.findUnique({
      where: { userId },
      include: { categories: true },
    });
    if (!seller) throw new ForbiddenException();
    await tx.$queryRaw`SELECT id FROM "Seller" WHERE id = ${seller.id} FOR UPDATE`;
    const currentSeller = await tx.seller.findUniqueOrThrow({
      where: { id: seller.id },
    });
    try {
      assertLeadAvailable(
        fresh.status,
        fresh.purchases.length,
        fresh.maxSlots,
        fresh.purchases.some((p) => p.sellerId === seller.id),
        seller.categories.some((c) => c.categoryId === fresh.categoryId),
      );
    } catch (e) {
      throw new ConflictException((e as Error).message);
    }
    if (!paymentId && fresh.price > 0) {
      if (
        currentSeller.credits < 1 ||
        !currentSeller.subscriptionExpiresAt ||
        currentSeller.subscriptionExpiresAt <= new Date()
      )
        throw new BadRequestException(
          "No active lead credits; verified payment is required",
        );
      await tx.seller.update({
        where: { id: seller.id },
        data: { credits: { decrement: 1 } },
      });
    }
    if (paymentId) {
      const p = await tx.payment.findUnique({ where: { id: paymentId } });
      if (
        !p ||
        p.status !== "CAPTURED" ||
        p.type !== "LEAD" ||
        p.userId !== userId ||
        p.targetId !== leadId
      )
        throw new ForbiddenException("Invalid verified payment");
    }
    const purchase = await tx.leadPurchase.create({
      data: {
        leadId,
        sellerId: seller.id,
        usedCredit: !paymentId && fresh.price > 0,
        paymentId,
      },
    });
    // Supplier contact-slot capacity is enforced independently of buyer fulfilment.
    await tx.auditLog.create({
      data: { actorId: userId, action: "LEAD_UNLOCK", targetId: leadId },
    });
    return purchase;
  }
  async reviewLead(actorId: string, id: string, dto: LeadReviewDto) {
    if (dto.status !== undefined && !["ACTIVE", "PENDING", "REJECTED"].includes(dto.status))
      throw new BadRequestException("Admin review supports only Active, Pending, and Rejected");
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${id} FOR UPDATE`;
      const count = await tx.leadPurchase.count({ where: { leadId: id } });
      if (dto.maxSlots && dto.maxSlots < count)
        throw new BadRequestException(
          "Slots cannot be less than existing purchases",
        );
      const lead = await tx.lead.update({ where: { id }, data: dto });
      if (dto.status === "ACTIVE") {
        const sellers = await tx.seller.findMany({
          where: {
            categories: { some: { categoryId: lead.categoryId } },
            user: { active: true },
          },
          select: { userId: true },
        });
        if (sellers.length)
          await tx.notification.createMany({
            data: sellers.map((s) => ({
              userId: s.userId,
              message: `New requirement: ${lead.title}. Buyer contact is available after unlocking.`,
            })),
          });
        if (sellers.length)
          await tx.noticeDelivery.createMany({
            data: sellers.map((s) => ({
              userId: s.userId,
              subject: "Roxodeal new requirement",
              message: `New requirement: ${lead.title}. Sign in to review and unlock buyer contact.`,
            })),
          });
      }
      await tx.auditLog.create({
        data: {
          actorId,
          action: "LEAD_REVIEW",
          targetId: id,
          details: { status: dto.status, price: dto.price },
        },
      });
      return lead;
    });
  }
}
