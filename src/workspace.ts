import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Post,
  Param,
  Query,
  Req,
} from "@nestjs/common";
import { IsIn, IsObject, IsOptional, IsString } from "class-validator";
import { Prisma, KycStatus, LeadStatus } from "@prisma/client";
import { Db } from "./prisma";
import { Public, Session } from "./security";
import { MarketplaceService } from "./marketplace.service";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LeadDto, ProductDto, SellerProfileDto, RegisterDto } from "./dto";
import { Notices } from "./notices";
import { kycReviewMessage } from "./kyc-review";
import { AuthService } from "./auth";
const actions = [
  "PLAN_CREATE",
  "CATEGORY_CREATE",
  "LEAD_UPDATE",
  "ACCOUNT_CREATE",
  "ANNOUNCEMENT",
  "PROFILE",
  "PRODUCT_CREATE",
  "PRODUCT_UPDATE",
  "LEAD_CREATE",
  "LEAD_REVIEW",
  "BUYER_LEAD_STATUS",
  "BUYER_LEAD_DELETE",
  "KYC_SUBMIT",
  "SELLER_REVIEW",
  "PLAN_UPDATE",
  "CLAIM_CREATE",
  "CLAIM_UPDATE",
  "CMS_UPDATE",
  "SAVE_PRODUCT",
  "ENQUIRY_CREATE",
  "NOTIFICATION_DELETE",
  "ENQUIRY_RESPONSE",
  "USER_REVIEW",
  "CATEGORY_UPDATE",
  "PROTECTION_CREATE",
  "PROTECTION_REVIEW",
  "NOTIFICATION_READ",
  "ATTACH_DOCUMENTS",
] as const;
export class MutationDto {
  @IsIn(actions) action!: (typeof actions)[number];
  @IsOptional() @IsString() id?: string;
  @IsObject() data!: Record<string, any>;
}
const label = (s: string) =>
  s
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
const status = (s: string) => s.toUpperCase().replaceAll(" ", "_");
const text = (v: any, min = 1, max = 5000) => {
  if (typeof v !== "string" || v.trim().length < min || v.length > max)
    throw new BadRequestException("Invalid text value");
  return v.trim();
};
const number = (v: any, min = 0) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > 100000000)
    throw new BadRequestException("Invalid numeric value");
  return v;
};
const paise = (v: any) => Math.round(number(v) * 100);
async function checked<T extends object>(
  cls: new () => T,
  data: any,
): Promise<T> {
  const dto = plainToInstance(cls, data);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length)
    throw new BadRequestException(
      errors.map((e) => Object.values(e.constraints || {})).flat(),
    );
  return dto;
}
@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(MarketplaceService) private market: MarketplaceService,
    @Inject(Notices) private notices: Notices,
    @Inject(AuthService) private auth: AuthService,
  ) {}
  async snapshot(session?: Session) {
    const user = session
      ? await this.db.user.findUniqueOrThrow({ where: { id: session.id } })
      : null;
    const admin = session?.role === "ADMIN",
      supplier = session?.role === "SELLER";
    const [rawSellers, rawProducts, plans, categories, pages] =
      await Promise.all([
        this.db.seller.findMany({
          where: admin ? {} : { user: { active: true } },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                active: true,
              },
            },
            categories: { include: { category: true } },
            plan: true,
          },
        }),
        this.db.product.findMany({
          where: admin
            ? {}
            : supplier
              ? {
                  OR: [
                    { seller: { userId: session!.id } },
                    { active: true, seller: { user: { active: true } } },
                  ],
                }
              : { active: true, seller: { user: { active: true } } },
          include: { category: true },
        }),
        this.db.plan.findMany({
          where: admin
            ? {}
            : supplier
              ? {
                  OR: [
                    { active: true },
                    { sellers: { some: { userId: session!.id } } },
                  ],
                }
              : { active: true },
          orderBy: { price: "asc" },
        }),
        this.db.category.findMany({ orderBy: { name: "asc" } }),
        this.db.cmsPage.findMany(),
      ]);
    const own = rawSellers.find((s) => s.userId === session?.id);
    if (own)
      rawSellers.sort((a, b) =>
        a.id === own.id ? -1 : b.id === own.id ? 1 : 0,
      );
    const sellers = rawSellers.map((s) => ({
      id: s.id,
      userId: admin ? s.userId : undefined,
      company: s.company,
      name: s.user.name,
      city: s.city,
      category: s.categories[0]?.category.name || "",
      categoryIds: s.categories.map((c) => c.categoryId),
      kyc: label(s.kyc),
      years: s.years,
      plan:
        s.subscriptionExpiresAt && s.subscriptionExpiresAt > new Date()
          ? s.planId
          : plans.find((p) => p.name === "Free")?.id || "",
      credits:
        (admin || s.userId === session?.id) &&
        s.subscriptionExpiresAt &&
        s.subscriptionExpiresAt > new Date()
          ? s.credits
          : 0,
      active: s.user.active,
      kycNote: admin || s.userId === session?.id ? s.kycNote : undefined,
      email: admin || s.userId === session?.id ? s.user.email : "",
      phone: admin || s.userId === session?.id ? s.user.phone : "",
      state: s.state,
      address: s.address,
      pincode: s.pincode,
      gst: admin || s.userId === session?.id ? s.gst : null,
      pan: admin || s.userId === session?.id ? s.pan : null,
      subscriptionExpiresAt: s.subscriptionExpiresAt,
    }));
    let leads: any[] = [];
    if (session?.role === "SELLER") {
      const rows = await this.market.leads(session.id);
      leads = rows.map((l) => ({
        id: l.id,
        title: l.title,
        category: categories.find((c) => c.id === l.categoryId)?.name || "",
        quantity: l.quantity,
        unit: l.unit,
        budget: l.budget / 100,
        city: l.city,
        description: l.description,
        date: l.requiredBy.toISOString().slice(0, 10),
        status: label(l.status),
        price: l.price / 100,
        purchases: [
          ...(l.unlocked && own ? [own.id] : []),
          ...Array.from(
            { length: l.sold - (l.unlocked ? 1 : 0) },
            (_, i) => `slot-${i}`,
          ),
        ],
        buyerName: l.contact?.name || "",
        subcategory: l.subcategory,
        documentIds: l.unlocked ? l.documentIds : [],
        email: l.contact?.email || "",
        phone: l.contact?.phone || "",
      }));
    } else if (session) {
      const rows = await this.db.lead.findMany({
        where: { deletedAt: null, ...(admin ? {} : { buyerId: session.id }) },
        include: {
          category: true,
          buyer: { select: { name: true, email: true, phone: true } },
          purchases: { select: { sellerId: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      leads = rows.map((l) => ({
        id: l.id,
        title: l.title,
        category: l.category.name,
        quantity: l.quantity,
        unit: l.unit,
        budget: l.budget / 100,
        city: l.city,
        description: l.description,
        date: l.requiredBy.toISOString().slice(0, 10),
        status: label(l.status),
        price: l.price / 100,
        purchases: l.purchases.map((p) => p.sellerId),
        buyerName: l.buyer.name,
        subcategory: l.subcategory,
        documentIds: l.documentIds,
        email: l.buyer.email,
        phone: l.buyer.phone,
      }));
    }
    const [
      claims,
      notifications,
      saved,
      payments,
      enquiries,
      documents,
      protections,
      buyers,
    ] = session
      ? await Promise.all([
          this.db.claim.findMany({
            where: admin
              ? {}
              : supplier
                ? { seller: { userId: session.id } }
                : { buyerId: session.id },
            orderBy: { createdAt: "desc" },
          }),
          this.db.notification.findMany({
            where: { userId: session.id },
            take: 50,
            orderBy: { createdAt: "desc" },
          }),
          this.db.savedProduct.findMany({ where: { userId: session.id } }),
          this.db.payment.findMany({
            where: admin ? {} : { userId: session.id },
            ...(supplier ? {} : { take: 100 }),
            orderBy: { createdAt: "desc" },
          }),
          this.db.enquiry.findMany({
            where: admin
              ? {}
              : supplier
                ? { seller: { userId: session.id } }
                : { buyerId: session.id },
            include: {
              buyer: { select: { name: true, email: true, phone: true } },
              seller: { select: { company: true } },
            },
            orderBy: { createdAt: "desc" },
          }),
          this.db.document.findMany({
            where: admin ? {} : { ownerId: session.id },
            select: {
              id: true,
              ownerId: true,
              filename: true,
              purpose: true,
              createdAt: true,
            },
          }),
          this.db.protection.findMany({
            where: admin
              ? {}
              : supplier
                ? { seller: { userId: session.id } }
                : { buyerId: session.id },
          }),
          admin
            ? this.db.user.findMany({
                where: { role: "BUYER" },
                select: {
                  id: true,
                  name: true,
                  email: true,
                  phone: true,
                  active: true,
                  city: true,
                  company: true,
                  protectionEligible: true,
                },
              })
            : Promise.resolve([]),
        ])
      : [[], [], [], [], [], [], [], []];
    if (session && !admin) {
      const evidence = claims.flatMap((c) => c.documentIds);
      const purchasedLeadDocuments = supplier
        ? leads.flatMap((l) => l.documentIds || [])
        : [];
      const shared = await this.db.document.findMany({
        where: {
          OR: [
            { id: { in: evidence }, purpose: "CLAIM" },
            { id: { in: purchasedLeadDocuments }, purpose: "LEAD" },
          ],
          ownerId: { not: session.id },
        },
        select: {
          id: true,
          ownerId: true,
          filename: true,
          purpose: true,
          createdAt: true,
        },
      });
      documents.push(...shared);
    }
    return {
      sellers,
      products: rawProducts.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category.name,
        price: p.price / 100,
        moq: p.moq,
        unit: p.unit,
        sellerId: p.sellerId,
        image: p.images[0] || "/roxodeal-mark.svg",
        images: p.images,
        status: p.active ? "Active" : "Inactive",
        description: p.description,
        specifications: p.specifications,
        subcategory: p.subcategory,
        maximumPrice: p.maximumPrice == null ? undefined : p.maximumPrice / 100,
      })),
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price / 100,
        listings: p.listingLimit,
        credits: p.leadCredits,
        active: p.active,
        durationDays: p.durationDays,
      })),
      leads,
      claims: claims.map((c) => ({
        id: c.id,
        title: c.title,
        sellerId: c.sellerId,
        amount: c.amount / 100,
        reason: c.explanation,
        status: label(c.status),
        response: c.response || "",
        reference: c.dealReference,
        documentIds: c.documentIds,
        approvedAmount:
          c.approvedAmount == null ? null : c.approvedAmount / 100,
        adminNote: c.adminNote,
        refundReference: c.refundReference,
        protectionId: c.protectionId,
      })),
      saved: saved.map((s) => s.productId),
      profile: {
        name: user?.name || "",
        company: user?.company || "",
        email: user?.email || "",
        phone: user?.phone || "",
        city: user?.city || "",
        state: user?.state || "",
        address: user?.address || "",
      },
      activity: notifications.map((n) => n.message),
      cms: Object.fromEntries(pages.map((p) => [p.slug, p.content])),
      categories,
      notifications,
      payments: payments.map(payment => ({ ...payment,
        payerName: rawSellers.find(s => s.userId === payment.userId)?.company || buyers.find(b => b.id === payment.userId)?.name || user?.name || "Marketplace account",
        payerEmail: admin ? rawSellers.find(s => s.userId === payment.userId)?.user.email || buyers.find(b => b.id === payment.userId)?.email || "" : user?.email || "",
        planName: payment.type === "SUBSCRIPTION" ? plans.find(plan => plan.id === payment.targetId)?.name || payment.targetId : null,
      })),
      enquiries,
      documents,
      protections,
      buyers,
    };
  }
  private require(session: Session, ...roles: string[]) {
    if (!roles.includes(session.role)) throw new ForbiddenException();
  }
  async kycContext(session: Session) {
    this.require(session, "ADMIN");
    const [user, notifications, kycReviewCount, leads, products, sellers, buyers] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: session.id }, select: { name: true, company: true, email: true, phone: true, city: true, state: true, address: true } }),
      this.db.notification.findMany({ where: { userId: session.id }, select: { message: true }, orderBy: { createdAt: "desc" }, take: 5 }),
      this.db.seller.count({ where: { kyc: { in: ["SUBMITTED", "UNDER_REVIEW"] } } }),
      this.db.lead.findMany({ select: { id: true } }),
      this.db.product.findMany({ select: { id: true } }),
      this.db.seller.findMany({ select: { id: true } }),
      this.db.user.findMany({ where: { role: "BUYER" }, select: { id: true } }),
    ]);
    return { profile: user, activity: notifications.map(n => n.message), kycReviewCount,
      navigationRecordIds: { leads: leads.map(r => r.id), products: products.map(r => r.id), sellers: sellers.map(r => r.id), buyers: buyers.map(r => r.id) } };
  }
  async kycList(session: Session, pageInput?: string) {
    this.require(session, "ADMIN");
    const page = pageInput === undefined ? 1 : Number(pageInput);
    if (!Number.isInteger(page) || page < 1 || page > 1000000)
      throw new BadRequestException("Page must be a positive integer");
    const pageSize = 20;
    const [rows, total] = await Promise.all([
      this.db.seller.findMany({ select: { id: true, company: true, city: true, kyc: true, user: { select: { name: true } } }, orderBy: [{ company: "asc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
      this.db.seller.count(),
    ]);
    return { items: rows.map(row => ({ id: row.id, company: row.company, city: row.city, name: row.user.name, kyc: label(row.kyc) })), total, page, pageSize };
  }
  async kycDetail(session: Session, id: string) {
    this.require(session, "ADMIN");
    const seller = await this.db.seller.findUnique({ where: { id }, select: { id: true, userId: true, company: true, city: true, state: true, address: true, pincode: true, gst: true, pan: true, years: true, kyc: true, kycNote: true, user: { select: { name: true, email: true, phone: true } } } });
    if (!seller) throw new NotFoundException("Seller not found");
    const documents = await this.db.document.findMany({ where: { ownerId: seller.userId, purpose: "KYC" }, select: { id: true, ownerId: true, filename: true, purpose: true }, orderBy: { createdAt: "desc" } });
    const { user, ...business } = seller;
    return { seller: { ...business, ...user, kyc: label(seller.kyc) }, documents };
  }
  async mutate(s: Session, dto: MutationDto) {
    const d = dto.data,
      id = dto.id;
    const own = () =>
      this.db.seller.findUniqueOrThrow({ where: { userId: s.id } });
    let result: any;
    switch (dto.action) {
      case "ACCOUNT_CREATE": {
        this.require(s, "ADMIN");
        result = await this.auth.register(await checked(RegisterDto, d));
        break;
      }
      case "ANNOUNCEMENT": {
        this.require(s, "ADMIN");
        const message = text(d.message, 5, 2000);
        if (!["BUYER", "SELLER", "ALL"].includes(d.audience))
          throw new BadRequestException("Invalid audience");
        const users = await this.db.user.findMany({
          where: {
            active: true,
            ...(d.audience === "ALL"
              ? { role: { in: ["BUYER", "SELLER"] as const } }
              : { role: d.audience }),
          },
          select: { id: true },
        });
        await this.db.$transaction(async (tx) => {
          await tx.notification.createMany({
            data: users.map((u) => ({ userId: u.id, message })),
          });
          await tx.noticeDelivery.createMany({
            data: users.map((u) => ({
              userId: u.id,
              message,
              subject: "Roxodeal announcement",
            })),
          });
        });
        break;
      }
      case "PLAN_CREATE": {
        this.require(s, "ADMIN");
        if (![d.listings, d.credits, d.durationDays].every(Number.isInteger))
          throw new BadRequestException(
            "Plan limits and duration must be integers",
          );
        result = await this.db.plan.create({
          data: {
            name: text(d.name, 2, 80),
            price: paise(d.price),
            listingLimit: number(d.listings),
            leadCredits: number(d.credits),
            durationDays: number(d.durationDays, 1),
          },
        });
        break;
      }
      case "CATEGORY_CREATE": {
        this.require(s, "ADMIN");
        result = await this.db.category.create({
          data: { name: text(d.name, 2, 100), leadPrice: paise(d.leadPrice) },
        });
        break;
      }
      case "LEAD_UPDATE": {
        this.require(s, "ADMIN");
        const data = await checked(LeadDto, { ...d, budget: paise(d.budget) });
        result = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Lead" WHERE id=${id!} FOR UPDATE`;
          if (await tx.leadPurchase.count({ where: { leadId: id } }))
            throw new BadRequestException(
              "Purchased lead details cannot be rewritten; use status and price review",
            );
          return tx.lead.update({
            where: { id },
            data: { ...data, requiredBy: new Date(data.requiredBy) },
          });
        });
        break;
      }
      case "ATTACH_DOCUMENTS": {
        this.require(s, "BUYER", "SELLER");
        if (
          !Array.isArray(d.documentIds) ||
          d.documentIds.length > 12 ||
          d.documentIds.some((x: any) => typeof x !== "string")
        )
          throw new BadRequestException("Invalid documents");
        const ids = [...new Set(d.documentIds)] as string[];
        const owned = await this.db.document.count({
          where: { id: { in: ids }, ownerId: s.id },
        });
        if (owned !== ids.length)
          throw new ForbiddenException("Documents must belong to your account");
        const purpose = d.type;
        if (
          ["CLAIM", "LEAD", "PROTECTION"].includes(purpose) &&
          (await this.db.document.count({
            where: { id: { in: ids }, purpose: { not: purpose } },
          }))
        )
          throw new BadRequestException(
            "Document purpose must match its attachment",
          );
        if (d.type === "CLAIM") {
          const c = await this.db.claim.findUniqueOrThrow({ where: { id } });
          if (
            c.buyerId !== s.id &&
            (s.role !== "SELLER" || c.sellerId !== (await own()).id)
          )
            throw new ForbiddenException();
          result = await this.db.claim.update({
            where: { id },
            data: {
              documentIds: { set: [...new Set([...c.documentIds, ...ids])] },
            },
          });
        } else if (d.type === "PROTECTION") {
          const p = await this.db.protection.findFirst({
            where: { id, buyerId: s.id },
          });
          if (!p) throw new ForbiddenException();
          result = await this.db.protection.update({
            where: { id },
            data: { documentIds: ids },
          });
        } else if (d.type === "LEAD") {
          this.require(s, "BUYER");
          const lead = await this.db.lead.findFirst({
            where: { id, buyerId: s.id },
          });
          if (!lead) throw new ForbiddenException();
          result = await this.db.lead.update({
            where: { id },
            data: { documentIds: ids },
          });
        } else throw new BadRequestException("Unknown attachment type");
        break;
      }
      case "PROFILE": {
        const user = await this.db.user.findUniqueOrThrow({
          where: { id: s.id },
        });
        if (
          (d.email !== undefined && d.email !== user.email) ||
          (d.phone !== undefined && d.phone !== user.phone)
        )
          throw new BadRequestException(
            "Email and phone changes require verification",
          );
        if (s.role === "SELLER") {
          const seller = await own();
          const category = d.category
            ? await this.db.category.findUnique({ where: { name: d.category } })
            : null;
          if (d.category !== undefined && !category)
            throw new BadRequestException("Choose a valid business category");
          const sellerProfile = await checked(SellerProfileDto, {
            company: d.company || seller.company,
            city: d.city ?? seller.city,
            state: d.state ?? seller.state,
            address: d.address ?? seller.address,
            pincode: d.pincode ?? seller.pincode,
            gst: d.gst ?? seller.gst ?? undefined,
            pan: d.pan ?? seller.pan ?? undefined,
            years: d.years ?? seller.years,
            categoryIds:
              (category
                ? [category.id]
                : d.categoryIds || (
                    await this.db.sellerCategory.findMany({
                      where: { sellerId: seller.id },
                    })
                  ).map((c) => c.categoryId)),
          });
          result = await this.db.$transaction(async (tx) => {
            await this.market.profile(s.id, sellerProfile, tx);
            return tx.user.update({
              where: { id: s.id },
              data: {
                name: text(d.name, 2, 100),
                company: text(d.company || " ", 0, 200),
                city: text(d.city || " ", 0, 100),
                state: text(d.state || " ", 0, 100),
                address: text(d.address || " ", 0, 500),
              },
            });
          });
        } else {
          result = await this.db.$transaction(async (tx) => {
            return tx.user.update({
              where: { id: s.id },
              data: {
                name: text(d.name, 2, 100),
                company: text(d.company || " ", 0, 200),
                city: text(d.city || " ", 0, 100),
                state: text(d.state || " ", 0, 100),
                address: text(d.address || " ", 0, 500),
              },
            });
          });
        }
        break;
      }
      case "PRODUCT_CREATE":
      case "PRODUCT_UPDATE": {
        this.require(s, "SELLER", "ADMIN");
        const category = await this.db.category.findUnique({
          where: { name: text(d.category) },
        });
        if (!category) throw new BadRequestException("Unknown category");
        const data = await checked(ProductDto, {
          name: d.name,
          description: d.description,
          categoryId: category.id,
          price: paise(d.price),
          moq: d.moq,
          unit: d.unit,
          images: d.images || [d.image],
          specifications: d.specifications,
          subcategory: d.subcategory || undefined,
          maximumPrice:
            d.maximumPrice == null ? undefined : paise(d.maximumPrice),
        });
        if (data.maximumPrice != null && data.maximumPrice < data.price)
          throw new BadRequestException(
            "Maximum price must be at least the starting price",
          );
        if (dto.action === "PRODUCT_CREATE") {
          this.require(s, "SELLER");
          result = await this.market.addProduct(
            s.id,
            data,
            id ? text(id, 5, 100) : undefined,
          );
        } else {
          const p = await this.db.product.findUnique({ where: { id } });
          if (!p) throw new NotFoundException();
          if (s.role === "SELLER" && p.sellerId !== (await own()).id)
            throw new ForbiddenException();
          result = await this.db.$transaction(async (tx) => {
            const seller = await tx.seller.findUniqueOrThrow({
              where: { id: p.sellerId },
              include: { plan: true, categories: true },
            });
            await tx.$queryRaw`SELECT id FROM "Seller" WHERE id=${seller.id} FOR UPDATE`;
            if (!seller.categories.some((c) => c.categoryId === category.id))
              throw new BadRequestException(
                "Product category must match the supplier",
              );
            const free = await tx.plan.findUnique({ where: { name: "Free" } });
            const limit =
              seller.subscriptionExpiresAt &&
              seller.subscriptionExpiresAt > new Date()
                ? (seller.plan?.listingLimit ?? 5)
                : (free?.listingLimit ?? 5);
            if (
              !p.active &&
              d.status === "Active" &&
              (await tx.product.count({
                where: { sellerId: seller.id, active: true },
              })) >= limit
            )
              throw new BadRequestException("Listing limit reached");
            return tx.product.update({
              where: { id },
              data: { ...data, active: d.status === "Active" },
            });
          });
        }
        break;
      }
      case "LEAD_CREATE": {
        this.require(s, "BUYER", "ADMIN");
        const buyerId = s.role === "ADMIN" ? text(d.buyerId) : s.id;
        if (
          s.role === "ADMIN" &&
          !(await this.db.user.findFirst({
            where: { id: buyerId, role: "BUYER", active: true },
          }))
        )
          throw new BadRequestException("Active buyer required");
        const cat = await this.db.category.findUnique({
          where: { name: text(d.category) },
        });
        if (!cat) throw new BadRequestException("Unknown category");
        result = await this.market.createLead(
          buyerId,
          await checked(LeadDto, {
            title: d.title,
            categoryId: cat.id,
            quantity: d.quantity,
            unit: d.unit,
            budget: paise(d.budget),
            city: d.city,
            description: d.description,
            requiredBy: d.date,
            subcategory: d.subcategory || undefined,
          }),
          id ? text(id, 5, 100) : undefined,
        );
        break;
      }
      case "BUYER_LEAD_STATUS":
      case "BUYER_LEAD_DELETE": {
        this.require(s, "BUYER");
        if (!id) throw new BadRequestException("Choose a requirement");
        const deleting = dto.action === "BUYER_LEAD_DELETE";
        const value = deleting ? "CLOSED" : status(text(d.status));
        if (!["CLOSED", "FULLY_SOLD"].includes(value)) throw new BadRequestException("Buyers can mark requirements Closed or Fully Sold");
        result = await this.db.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${id} FOR UPDATE`;
          const lead = await tx.lead.findUnique({ where: { id } });
          if (!lead || lead.buyerId !== s.id || lead.deletedAt) throw new NotFoundException("Requirement not found");
          return tx.lead.update({ where: { id }, data: { status: value as LeadStatus, ...(deleting ? { deletedAt: new Date() } : {}) } });
        });
        break;
      }
      case "LEAD_REVIEW": {
        this.require(s, "ADMIN");
        const value = d.status === undefined ? undefined : status(text(d.status));
        if (value !== undefined && !["ACTIVE", "PENDING", "REJECTED"].includes(value))
          throw new BadRequestException("Admin review supports only Active, Pending, and Rejected");
        result = await this.market.reviewLead(s.id, id!, {
          ...(value === undefined ? {} : { status: value as LeadStatus }),
          price: paise(d.price),
        });
        break;
      }
      case "KYC_SUBMIT": {
        this.require(s, "SELLER");
        result = await this.db.$transaction(async (tx) => {
          const seller = await tx.seller.findUniqueOrThrow({
            where: { userId: s.id },
          });
          await tx.$queryRaw`SELECT id FROM "Seller" WHERE id=${seller.id} FOR UPDATE`;
          const current = await tx.seller.findUniqueOrThrow({
            where: { id: seller.id },
          });
          if (["SUBMITTED", "UNDER_REVIEW", "APPROVED"].includes(current.kyc))
            throw new BadRequestException(
              current.kyc === "APPROVED"
                ? "Your business is already verified"
                : "Your documents are already submitted for review",
            );
          const docs = await tx.document.count({
            where: { ownerId: s.id, purpose: "KYC" },
          });
          if (!docs)
            throw new BadRequestException(
              "Upload at least one business verification document before submitting",
            );
          return tx.seller.update({
            where: { id: seller.id },
            data: { kyc: "SUBMITTED" },
          });
        });
        break;
      }
      case "SELLER_REVIEW": {
        this.require(s, "ADMIN");
        const data: any = {};
        if (d.kyc !== undefined) {
          const value = status(text(d.kyc));
          if (!Object.values(KycStatus).includes(value as KycStatus))
            throw new BadRequestException("Unknown KYC status");
          data.kyc = value;
          data.kycNote = kycReviewMessage(value as KycStatus, d.note);
        }
        if (d.credits !== undefined) data.credits = number(d.credits);
        if (d.plan !== undefined) {
          const plan = await this.db.plan.findUniqueOrThrow({
            where: { id: text(d.plan) },
          });
          data.planId = plan.id;
          data.subscriptionExpiresAt = new Date(
            Date.now() + plan.durationDays * 86400000,
          );
        }
        result = await this.db.seller.update({ where: { id }, data });
        if (d.kyc !== undefined)
          await this.notices.send(
            result.userId,
            `Your KYC status is ${d.kyc}. ${data.kycNote}`,
          );
        break;
      }
      case "PLAN_UPDATE": {
        this.require(s, "ADMIN");
        const currentPlan = await this.db.plan.findUniqueOrThrow({
          where: { id },
        });
        if (
          currentPlan.name === "Free" &&
          (d.price !== 0 || d.active === false)
        )
          throw new BadRequestException(
            "The Free plan must remain free and active",
          );
        if (
          ![
            d.listings,
            d.credits,
            ...(d.durationDays == null ? [] : [d.durationDays]),
          ].every(Number.isInteger)
        )
          throw new BadRequestException(
            "Plan limits and duration must be integers",
          );
        result = await this.db.plan.update({
          where: { id },
          data: {
            price: paise(d.price),
            listingLimit: number(d.listings),
            leadCredits: number(d.credits),
            ...(d.active !== undefined ? { active: d.active === true } : {}),
            ...(d.durationDays !== undefined
              ? { durationDays: number(d.durationDays, 1) }
              : {}),
          },
        });
        break;
      }
      case "CLAIM_CREATE": {
        this.require(s, "BUYER");
        const protectionId = text(d.protectionId);
        result = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Protection" WHERE id = ${protectionId} FOR UPDATE`;
          const protection = await tx.protection.findFirst({
            where: { id: protectionId, buyerId: s.id, status: "ACTIVE" },
          });
          if (!protection)
            throw new BadRequestException(
              "An active protected transaction is required",
            );
          const amount = paise(d.amount);
          if (amount < 1 || amount > protection.dealAmount)
            throw new BadRequestException("Invalid claim amount");
          const claim = await tx.claim.create({
            data: {
              ...(id ? { id: text(id, 5, 100) } : {}),
              buyerId: s.id,
              sellerId: protection.sellerId,
              protectionId,
              title: text(d.title),
              dealReference: protection.reference,
              explanation: text(d.reason, 10),
              amount,
              documentIds: [],
            },
          });
          await tx.protection.update({
            where: { id: protectionId },
            data: { status: "CLAIM_RAISED" },
          });
          const seller = await tx.seller.findUniqueOrThrow({
            where: { id: protection.sellerId },
          });
          const message =
            "A buyer has raised a protection claim. Submit your response and evidence.";
          await tx.notification.create({
            data: { userId: seller.userId, message },
          });
          await tx.noticeDelivery.create({
            data: {
              userId: seller.userId,
              subject: "Roxodeal protection claim",
              message,
            },
          });
          return claim;
        });
        break;
      }
      case "CLAIM_UPDATE": {
        this.require(s, "SELLER", "ADMIN");
        const c = await this.db.claim.findUniqueOrThrow({ where: { id } });
        if (s.role === "SELLER") {
          if (c.sellerId !== (await own()).id) throw new ForbiddenException();
          result = await this.db.claim.update({
            where: { id },
            data: { response: text(d.response, 10) },
          });
        } else {
          const value = status(text(d.status));
          if (
            ![
              "UNDER_REVIEW",
              "NEED_MORE_INFORMATION",
              "APPROVED",
              "REJECTED",
              "RESOLVED",
            ].includes(value)
          )
            throw new BadRequestException("Unknown decision");
          const approved =
            d.approvedAmount === undefined
              ? c.approvedAmount
              : paise(d.approvedAmount);
          if (approved !== null && approved > c.amount)
            throw new BadRequestException("Approved amount exceeds claim");
          result = await this.db.claim.update({
            where: { id },
            data: {
              status: value,
              approvedAmount:
                value === "APPROVED" ? (approved ?? c.amount) : approved,
              adminNote: d.adminNote ? text(d.adminNote) : c.adminNote,
              refundReference: d.refundReference
                ? text(d.refundReference)
                : c.refundReference,
            },
          });
          await this.notices.send(
            c.buyerId,
            `Your claim ${c.id} is ${d.status}. Check your account for the administrator decision.`,
          );
        }
        if (s.role === "SELLER")
          await this.notices.send(
            c.buyerId,
            "The supplier has responded to your protection claim.",
          );
        break;
      }
      case "CMS_UPDATE": {
        this.require(s, "ADMIN");
        const slug = text(id, 1, 80);
        result = await this.db.cmsPage.upsert({
          where: { slug },
          create: {
            slug,
            title: text(d.title || slug, 1, 200),
            content: text(d.content, 0, 100000),
            seoDescription:
              d.seoDescription == null ? null : text(d.seoDescription, 0, 500),
          },
          update: {
            content: text(d.content, 0, 100000),
            ...(d.title ? { title: text(d.title, 1, 200) } : {}),
            ...(d.seoDescription !== undefined
              ? { seoDescription: text(d.seoDescription, 0, 500) }
              : {}),
          },
        });
        break;
      }
      case "SAVE_PRODUCT": {
        this.require(s, "BUYER");
        await this.db.product.findUniqueOrThrow({ where: { id } });
        if (d.saved === true)
          result = await this.db.savedProduct.upsert({
            where: { userId_productId: { userId: s.id, productId: id! } },
            create: { userId: s.id, productId: id! },
            update: {},
          });
        else
          result = await this.db.savedProduct.deleteMany({
            where: { userId: s.id, productId: id },
          });
        break;
      }
      case "ENQUIRY_CREATE": {
        this.require(s, "BUYER");
        const kind = d.kind === undefined ? "ENQUIRY" : d.kind;
        if (!["ENQUIRY", "QUOTE"].includes(kind)) throw new BadRequestException("Choose quote or enquiry");
        const seller = await this.db.seller.findFirst({ where: { id: text(d.sellerId), user: { active: true } } });
        if (!seller) throw new BadRequestException("Supplier is unavailable");
        const productId = d.productId === undefined ? undefined : text(d.productId);
        if (kind === "QUOTE" && !productId) throw new BadRequestException("Select a product for your quote");
        if (productId && !await this.db.product.findFirst({ where: { id: productId, sellerId: seller.id, active: true } }))
          throw new BadRequestException("Product does not belong to this supplier or is unavailable");
        if (kind === "QUOTE" && (!Number.isInteger(d.quantity) || d.quantity < 1)) throw new BadRequestException("Enter a positive quantity");
        result = await this.db.enquiry.create({ data: {
          buyerId: s.id, sellerId: seller.id, productId, kind,
          quantity: kind === "QUOTE" ? number(d.quantity, 1) : null,
          message: text(d.message, 10),
        } });
        await this.notices.send(seller.userId, kind === "QUOTE" ? "You have a new product quote request." : "You have a new buyer enquiry.");
        break;
      }
      case "ENQUIRY_RESPONSE": {
        this.require(s, "SELLER");
        const e = await this.db.enquiry.findUniqueOrThrow({ where: { id } });
        if (e.sellerId !== (await own()).id) throw new ForbiddenException();
        result = await this.db.enquiry.update({
          where: { id },
          data: { response: text(d.response, 2) },
        });
        await this.notices.send(e.buyerId, "A supplier has replied to your quote or enquiry.");
        break;
      }
      case "USER_REVIEW": {
        this.require(s, "ADMIN");
        const u = await this.db.user.findUniqueOrThrow({ where: { id } });
        if (u.role === "ADMIN")
          throw new BadRequestException(
            "Admin accounts cannot be changed here",
          );
        result = await this.db.user.update({
          where: { id },
          data: {
            ...(typeof d.active === "boolean" ? { active: d.active } : {}),
            ...(typeof d.protectionEligible === "boolean"
              ? { protectionEligible: d.protectionEligible }
              : {}),
          },
        });
        break;
      }
      case "CATEGORY_UPDATE": {
        this.require(s, "ADMIN");
        result = await this.db.category.update({
          where: { id },
          data: { leadPrice: paise(d.leadPrice) },
        });
        break;
      }
      case "PROTECTION_CREATE": {
        this.require(s, "BUYER");
        const u = await this.db.user.findUniqueOrThrow({ where: { id: s.id } });
        if (!u.protectionEligible)
          throw new ForbiddenException("Buyer protection is suspended");
        const setting = await this.db.setting.findUnique({
          where: { key: "protectionFee" },
        });
        if (
          !setting ||
          typeof setting.value !== "number" ||
          setting.value < 100
        )
          throw new BadRequestException(
            "Buyer protection pricing is not configured",
          );
        const deliveryDate = new Date(text(d.deliveryDate));
        if (
          !Number.isFinite(deliveryDate.getTime()) ||
          !Number.isInteger(d.quantity)
        )
          throw new BadRequestException("Invalid delivery date or quantity");
        result = await this.db.protection.create({
          data: {
            buyerId: s.id,
            sellerId: text(d.sellerId),
            reference: text(d.reference),
            product: text(d.product),
            quantity: number(d.quantity, 1),
            dealAmount: paise(d.dealAmount),
            fee: setting.value,
            deliveryDate,
            terms: text(d.terms, 10),
            documentIds: [],
          },
        });
        break;
      }
      case "PROTECTION_REVIEW": {
        this.require(s, "ADMIN");
        if (id === "fee") {
          result = await this.db.setting.upsert({
            where: { key: "protectionFee" },
            create: { key: "protectionFee", value: paise(d.fee) },
            update: { value: paise(d.fee) },
          });
        } else {
          const value = status(text(d.status));
          if (
            !["EXPIRED", "UNDER_REVIEW", "REJECTED", "RESOLVED"].includes(value)
          )
            throw new BadRequestException(
              "Protection is activated only by verified payment",
            );
          result = await this.db.protection.update({
            where: { id },
            data: { status: value },
          });
        }
        break;
      }
      case "NOTIFICATION_DELETE": {
        if (!id) throw new BadRequestException("Choose a notification");
        result = await this.db.notification.deleteMany({ where: { id, userId: s.id } });
        break;
      }
      case "NOTIFICATION_READ": {
        result = await this.db.notification.updateMany({
          where: { id, userId: s.id },
          data: { read: true },
        });
        break;
      }
      default:
        throw new BadRequestException("Unsupported action");
    }
    await this.db.auditLog.create({
      data: {
        actorId: s.id,
        action: dto.action,
        targetId: id || result?.id || s.id,
        details: d.note ? { note: text(d.note, 1, 5000) } : {},
      },
    });
    return { ok: true, id: result?.id };
  }
}
@Controller()
export class WorkspaceController {
  constructor(@Inject(WorkspaceService) private service: WorkspaceService) {}
  @Public() @Get("catalogue") catalogue() {
    return this.service.snapshot();
  }
  @Get("workspace") workspace(@Req() req: any, @Query("view") view?: string) {
    if (view === "kyc") return this.service.kycContext(req.user);
    return this.service.snapshot(req.user);
  }
  @Get("admin/kyc") kycList(@Req() req: any, @Query("page") page?: string) {
    return this.service.kycList(req.user, page);
  }
  @Get("admin/kyc/:id") kycDetail(@Req() req: any, @Param("id") id: string) {
    return this.service.kycDetail(req.user, id);
  }
  @Post("workspace/actions") action(@Req() req: any, @Body() dto: MutationDto) {
    return this.service.mutate(req.user, dto);
  }
}
