import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  ForbiddenException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Db } from "./prisma";
import { MarketplaceService } from "./marketplace.service";
export function verifyWebhook(body: Buffer, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(body).digest();
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
@Injectable()
export class Payments {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(MarketplaceService) private marketplace: MarketplaceService,
  ) {}
  private async gateway(path: string, init: RequestInit = {}) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
      throw new ServiceUnavailableException("Razorpay is not configured");
    // The override is restricted to isolated tests; production always uses Razorpay.
    const base = process.env.NODE_ENV === "test" && process.env.RAZORPAY_TEST_API_URL
      ? process.env.RAZORPAY_TEST_API_URL : "https://api.razorpay.com/v1";
    const response = await fetch(base + path, {
      ...init,
      headers: { Authorization: "Basic " + Buffer.from(process.env.RAZORPAY_KEY_ID + ":" + process.env.RAZORPAY_KEY_SECRET).toString("base64"), "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ServiceUnavailableException("Payment gateway verification is unavailable. Please retry checking your payment.");
    return response.json();
  }
  private async ownedOrder(userId: string, orderId: string) {
    const payment = await this.db.payment.findUnique({ where: { gatewayOrderId: orderId } });
    if (!payment || payment.userId !== userId) throw new ForbiddenException("Payment order is not available to your account");
    return payment;
  }
  async verify(userId: string, dto: { orderId: string; paymentId: string; signature: string }) {
    const payment = await this.ownedOrder(userId, dto.orderId);
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) throw new ServiceUnavailableException("Razorpay is not configured");
    if (!verifyWebhook(Buffer.from(payment.gatewayOrderId + "|" + dto.paymentId), dto.signature, secret))
      throw new BadRequestException("Invalid payment signature");
    if (payment.status === "CAPTURED") return this.paymentStatus(payment.id);
    let entity = await this.gateway("/payments/" + encodeURIComponent(dto.paymentId));
    this.validateEntity(entity, payment.gatewayOrderId!, payment.amount);
    if (entity.id !== dto.paymentId) throw new BadRequestException("Payment reference mismatch");
    if (entity.status === "authorized") {
      try {
        entity = await this.gateway("/payments/" + encodeURIComponent(dto.paymentId) + "/capture", { method: "POST", body: JSON.stringify({ amount: payment.amount, currency: "INR" }) });
      } catch {
        // Auto-capture or a webhook may have won the race. Check the actual gateway state.
        entity = await this.gateway("/payments/" + encodeURIComponent(dto.paymentId));
      }
    }
    this.validateEntity(entity, payment.gatewayOrderId!, payment.amount);
    if (entity.id !== dto.paymentId) throw new BadRequestException("Payment reference mismatch");
    if (entity.status === "captured") await this.fulfilCaptured(entity);
    return this.paymentStatus(payment.id);
  }
  async checkStatus(userId: string, orderId: string) {
    const payment = await this.ownedOrder(userId, orderId);
    if (payment.status !== "CAPTURED") {
      const result = await this.gateway("/orders/" + encodeURIComponent(orderId) + "/payments");
      const captured = result.items?.find((entity: any) => entity.status === "captured");
      if (captured) {
        this.validateEntity(captured, orderId, payment.amount);
        await this.fulfilCaptured(captured);
      }
    }
    return this.paymentStatus(payment.id);
  }
  private async paymentStatus(id: string) {
    const payment = await this.db.payment.findUniqueOrThrow({ where: { id } });
    return { status: payment.status, refundRequired: payment.refundRequired, type: payment.type, targetId: payment.targetId };
  }
  private validateEntity(entity: any, orderId: string, amount: number) {
    if (!entity || typeof entity.id !== "string" || entity.order_id !== orderId || entity.amount !== amount || entity.currency !== "INR")
      throw new BadRequestException("Payment order, currency or amount mismatch");
  }
  async order(
    userId: string,
    type: "LEAD" | "SUBSCRIPTION" | "PROTECTION",
    targetId: string,
  ) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
      throw new ServiceUnavailableException("Razorpay is not configured");
    let amount: number;
    if (type === "LEAD") {
      const leads = await this.marketplace.leads(userId);
      const lead = leads.find((l) => l.id === targetId);
      if (
        !lead ||
        lead.unlocked ||
        lead.slotsRemaining < 1 ||
        !["ACTIVE", "PARTIALLY_SOLD"].includes(lead.status)
      )
        throw new ConflictException("Lead is unavailable");
      amount = lead.price;
      const seller = await this.db.seller.findUnique({ where: { userId }, include: { categories: true } });
      if (!seller?.categories.some(category => category.categoryId === lead.categoryId))
        throw new BadRequestException("Choose a matching business category before purchasing this lead");
    } else if (type === "PROTECTION") {
      const protection = await this.db.protection.findFirst({
        where: { id: targetId, buyerId: userId, status: "PENDING" },
      });
      if (!protection)
        throw new BadRequestException("Protected transaction is unavailable");
      amount = protection.fee;
    } else {
      const seller = await this.db.seller.findUnique({ where: { userId } });
      if (!seller) throw new BadRequestException("Supplier profile required");
      const plan = await this.db.plan.findUnique({ where: { id: targetId } });
      if (!plan?.active) throw new BadRequestException("Plan unavailable");
      amount = plan.price;
    }
    if (amount < 100)
      throw new BadRequestException("Use free lead unlocking or the free plan");
    const p = await this.db.payment.create({
      data: { userId, type, targetId, amount },
    });
    let result: { id: string };
    try {
      result = await this.gateway("/orders", { method: "POST", body: JSON.stringify({ amount, currency: "INR", receipt: p.id }) });
      if (!result.id) throw new ServiceUnavailableException("Gateway order creation failed");
    } catch (error) {
      await this.db.payment.update({ where: { id: p.id }, data: { status: "FAILED" } });
      throw error;
    }
    await this.db.payment.update({
      where: { id: p.id },
      data: { gatewayOrderId: result.id },
    });
    return {
      orderId: result.id,
      amount,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    };
  }
  async webhook(raw: Buffer, signature: string) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret)
      throw new ServiceUnavailableException("Webhook secret is not configured");
    if (!verifyWebhook(raw, signature, secret))
      throw new BadRequestException("Invalid webhook signature");
    const event = JSON.parse(raw.toString());
    if (event.event !== "payment.captured") return { received: true };
    const entity = event.payload?.payment?.entity;
    if (!entity || entity.currency !== "INR" || entity.status !== "captured")
      throw new BadRequestException("Invalid payment payload");
    return this.fulfilCaptured(entity);
  }
  private async fulfilCaptured(entity: any) {
    if (entity.status !== "captured") throw new BadRequestException("Payment has not been captured");
    return this.db.$transaction(async (tx) => {
      const p = await tx.payment.findUnique({
        where: { gatewayOrderId: entity.order_id },
      });
      if (!p) throw new BadRequestException("Unknown gateway order");
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${p.id} FOR UPDATE`;
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: p.id },
      });
      if (current.status === "CAPTURED") return { received: true };
      if (current.amount !== entity.amount)
        throw new BadRequestException("Payment amount mismatch");
      await tx.payment.update({
        where: { id: p.id },
        data: { status: "CAPTURED", gatewayPaymentId: entity.id },
      });
      if (p.type === "LEAD") {
        await tx.$executeRawUnsafe("SAVEPOINT lead_fulfilment");
        try {
          await this.marketplace.unlock(p.userId, p.targetId, p.id, tx);
        } catch (e) {
          if (!(e instanceof ConflictException)) throw e;
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT lead_fulfilment");
          await tx.payment.update({
            where: { id: p.id },
            data: { refundRequired: true },
          });
          await tx.notification.create({
            data: {
              userId: p.userId,
              message:
                "Your payment was received after the lead became unavailable. A manual refund review is required.",
            },
          });
        }
      } else if (p.type === "PROTECTION") {
        const activated = await tx.protection.updateMany({
          where: { id: p.targetId, buyerId: p.userId, status: "PENDING" },
          data: { status: "ACTIVE" },
        });
        if (!activated.count)
          await tx.payment.update({
            where: { id: p.id },
            data: { refundRequired: true },
          });
      } else if (p.type === "SUBSCRIPTION") {
        const plan = await tx.plan.findUniqueOrThrow({
          where: { id: p.targetId },
        });
        await tx.seller.update({
          where: { userId: p.userId },
          data: {
            planId: plan.id,
            credits: plan.leadCredits,
            subscriptionExpiresAt: new Date(
              Date.now() + plan.durationDays * 86400000,
            ),
          },
        });
        const purchaser = await tx.user.findUniqueOrThrow({ where: { id: p.userId }, select: { name: true, email: true } });
        const message = `${purchaser.name} (${purchaser.email}) purchased ${plan.name} for ₹${(p.amount / 100).toFixed(2)}. Plan activated with ${plan.leadCredits} lead credits for ${plan.durationDays} days. Payment: ${entity.id}.`;
        const admins = await tx.user.findMany({ where: { role: "ADMIN", active: true }, select: { id: true } });
        if (admins.length) {
          await tx.notification.createMany({ data: admins.map(admin => ({ userId: admin.id, message })) });
          await tx.noticeDelivery.createMany({ data: admins.map(admin => ({ userId: admin.id, subject: "Roxodeal subscription purchased", message })) });
        }
        await tx.notification.create({ data: { userId: p.userId, message: `${plan.name} is now active with ${plan.leadCredits} lead credits for ${plan.durationDays} days.` } });
      }
      await tx.auditLog.create({
        data: { actorId: p.userId, action: "PAYMENT_CAPTURED", targetId: p.id },
      });
      await tx.notification.create({
        data: {
          userId: p.userId,
          message: `Payment received for ${p.type.toLowerCase()}. Reference: ${entity.id}.`,
        },
      });
      await tx.noticeDelivery.create({
        data: {
          userId: p.userId,
          subject: "Roxodeal payment received",
          message: `Payment received for ${p.type.toLowerCase()}. Reference: ${entity.id}. Check your account for fulfilment or refund review status.`,
        },
      });
      return { received: true };
    });
  }
}
