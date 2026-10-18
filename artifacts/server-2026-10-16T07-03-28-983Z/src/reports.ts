import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { IsEmail, IsIn, IsString } from "class-validator";
import { createHash } from "node:crypto";
import { Db } from "./prisma";
import { Public, Roles } from "./security";
import { RedisConnection } from "./redis";
class ViewDto {
  @IsIn(["PRODUCT", "SUPPLIER"]) kind!: string;
  @IsString() id!: string;
}
class NewsletterDto {
  @IsEmail() email!: string;
}
@Controller()
export class ReportsController {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(RedisConnection) private redis: RedisConnection,
  ) {}
  @Public() @Post("newsletter") async newsletter(
    @Body() d: NewsletterDto,
    @Req() req: any,
  ) {
    const email = d.email.toLowerCase(),
      key = "newsletter:" + createHash("sha256").update(email).digest("hex");
    await this.db.setting.upsert({
      where: { key },
      create: { key, value: { email, subscribedAt: new Date().toISOString() } },
      update: {},
    });
    return { ok: true };
  }
  @Public() @Post("events/view") async view(
    @Body() d: ViewDto,
    @Req() req: any,
  ) {
    const seller =
      d.kind === "PRODUCT"
        ? (
            await this.db.product.findFirst({
              where: { id: d.id, active: true },
            })
          )?.sellerId
        : (await this.db.seller.findUnique({ where: { id: d.id } }))?.id;
    if (!seller) throw new BadRequestException("Listing not found");
    const hash = createHash("sha256")
      .update((req.ip || "unknown") + ":" + d.id + ":" + d.kind)
      .digest("hex");
    if (await this.redis.limit("view:" + hash, 1, 86400))
      await this.db.viewEvent.create({
        data: {
          sellerId: seller,
          productId: d.kind === "PRODUCT" ? d.id : null,
          kind: d.kind,
        },
      });
    return { ok: true };
  }
  @Roles("ADMIN") @Get("admin/system-status") status() {
    return {
      smtpConfigured: !!(process.env.SMTP_HOST && process.env.SMTP_FROM),
      smsConfigured: !!(
        process.env.SMS_PROVIDER_URL && process.env.SMS_PROVIDER_TOKEN
      ),
      paymentsConfigured: !!(
        process.env.RAZORPAY_KEY_ID &&
        process.env.RAZORPAY_KEY_SECRET &&
        process.env.RAZORPAY_WEBHOOK_SECRET
      ),
    };
  }
  @Roles("ADMIN") @Get("admin/reports") async reports(
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const start = from ? new Date(from) : new Date(Date.now() - 365 * 86400000),
      end = to ? new Date(to) : new Date();
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start > end
    )
      throw new BadRequestException("Invalid report dates");
    const period = { gte: start, lte: end };
    const [buyers, sellers, products, leads, claims, payments, purchases, kyc] =
      await Promise.all([
        this.db.user.count({ where: { role: "BUYER" } }),
        this.db.seller.count(),
        this.db.product.count(),
        this.db.lead.groupBy({ by: ["status"], _count: true }),
        this.db.claim.groupBy({ by: ["status"], _count: true }),
        this.db.payment.findMany({
          where: { createdAt: period, status: "CAPTURED" },
        }),
        this.db.leadPurchase.findMany({
          where: { createdAt: period },
          include: {
            lead: { select: { categoryId: true } },
            seller: { select: { company: true } },
          },
        }),
        this.db.seller.groupBy({ by: ["kyc"], _count: true }),
      ]);
    const revenue: Record<string, number> = {
        LEAD: 0,
        SUBSCRIPTION: 0,
        PROTECTION: 0,
      },
      monthly: Record<string, number> = {};
    for (const p of payments) {
      revenue[p.type] = (revenue[p.type] || 0) + p.amount;
      const month = p.createdAt.toISOString().slice(0, 7);
      monthly[month] = (monthly[month] || 0) + p.amount;
    }
    return {
      from: start,
      to: end,
      buyers,
      sellers,
      products,
      leads,
      claims,
      kyc,
      revenuePaise: revenue,
      totalRevenuePaise: Object.values(revenue).reduce((a, b) => a + b, 0),
      monthlyRevenuePaise: monthly,
      purchases: purchases.map((p) => ({
        id: p.id,
        categoryId: p.lead.categoryId,
        seller: p.seller.company,
        usedCredit: p.usedCredit,
        createdAt: p.createdAt,
      })),
      transactions: payments.length,
      activeSubscriptions: await this.db.seller.count({
        where: { subscriptionExpiresAt: { gt: new Date() } },
      }),
    };
  }
  @Roles("SELLER") @Get("seller/analytics") async seller(@Req() req: any) {
    const seller = await this.db.seller.findUniqueOrThrow({
      where: { userId: req.user.id },
    });
    return {
      productViews: await this.db.viewEvent.count({
        where: { sellerId: seller.id, kind: "PRODUCT" },
      }),
      profileViews: await this.db.viewEvent.count({
        where: { sellerId: seller.id, kind: "SUPPLIER" },
      }),
      enquiries: await this.db.enquiry.count({
        where: { sellerId: seller.id },
      }),
      leadsPurchased: await this.db.leadPurchase.count({
        where: { sellerId: seller.id },
      }),
      creditsConsumed: await this.db.leadPurchase.count({
        where: { sellerId: seller.id, usedCredit: true },
      }),
      activeListings: await this.db.product.count({
        where: { sellerId: seller.id, active: true },
      }),
    };
  }
}
