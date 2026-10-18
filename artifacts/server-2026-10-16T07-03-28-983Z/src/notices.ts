import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Db } from "./prisma";
import { Delivery } from "./delivery";
@Injectable()
export class Notices implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private logger = new Logger(Notices.name);
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Delivery) private delivery: Delivery,
  ) {}
  async send(
    userId: string,
    message: string,
    subject = "Roxodeal account update",
    dedupeKey?: string,
  ) {
    if (
      dedupeKey &&
      (await this.db.notification.findUnique({ where: { dedupeKey } }))
    )
      return;
    await this.db.$transaction(async (tx) => {
      await tx.notification.create({ data: { userId, message, dedupeKey } });
      await tx.noticeDelivery.create({ data: { userId, subject, message } });
    });
  }
  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 60000);
    void this.tick();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const expiring = await this.db.seller.findMany({
        where: {
          subscriptionExpiresAt: {
            gte: new Date(Date.now() - 86400000),
            lte: new Date(Date.now() + 3 * 86400000),
          },
          user: { active: true },
        },
      });
      for (const s of expiring) {
        const expiry = s.subscriptionExpiresAt!;
        try {
          await this.send(
            s.userId,
            expiry > new Date()
              ? `Your subscription expires on ${expiry.toISOString().slice(0, 10)}. Renew to keep paid listing limits and lead credits.`
              : "Your subscription has expired. Free-plan limits now apply.",
            "Roxodeal subscription reminder",
            `renewal:${s.id}:${expiry.toISOString()}:${expiry > new Date() ? "soon" : "expired"}`,
          );
        } catch (e) {
          if ((e as any).code !== "P2002") throw e;
        }
      }
      if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return;
      await this.db.noticeDelivery.updateMany({
        where: {
          status: "SENDING",
          nextAttemptAt: { lt: new Date(Date.now() - 120000) },
        },
        data: { status: "PENDING" },
      });
      const jobs = await this.db.noticeDelivery.findMany({
        where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
        take: 20,
        include: { user: { select: { email: true, active: true } } },
      });
      for (const job of jobs) {
        const claimed = await this.db.noticeDelivery.updateMany({
          where: { id: job.id, status: "PENDING" },
          data: { status: "SENDING", nextAttemptAt: new Date() },
        });
        if (!claimed.count) continue;
        try {
          if (job.user.active)
            await this.delivery.email(job.user.email, job.subject, job.message);
          await this.db.noticeDelivery.update({
            where: { id: job.id },
            data: { status: "SENT" },
          });
        } catch {
          const attempts = job.attempts + 1;
          await this.db.noticeDelivery.update({
            where: { id: job.id },
            data: {
              attempts,
              status: attempts >= 5 ? "FAILED" : "PENDING",
              nextAttemptAt: new Date(
                Date.now() + Math.min(2 ** attempts * 60000, 3600000),
              ),
            },
          });
        }
      }
    } catch {
      this.logger.error(
        "Notification worker failed; it will retry on the next interval",
      );
    } finally {
      this.running = false;
    }
  }
}
