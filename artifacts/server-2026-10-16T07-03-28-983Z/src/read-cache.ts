import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { defer, firstValueFrom, Observable } from "rxjs";
import { RedisConnection } from "./redis";
import { requestPath } from "./api-rate-limit";

export const MAX_CACHE_SECONDS = 60;
export function readPolicy(path: string): number {
  if (path === "/api/catalogue") return 30;
  if (
    /^\/api\/(products|categories|plans|reviews)$/.test(path) ||
    path.startsWith("/api/cms/")
  )
    return 60;
  if (path === "/api/auth/me") return 15;
  if (path === "/api/seller/analytics" || path === "/api/admin/reports")
    return 30;
  if (
    /^\/api\/(workspace|requirements|leads|notifications|payments)$/.test(path)
  )
    return 10;
  if (
    /^\/api\/admin\/(leads|sellers|kyc(?:\/[^/]+)?|contact-messages|feedback)$/.test(
      path,
    )
  )
    return 15;
  return 0;
}
export function cacheIdentity(req: any) {
  const url = new URL(req.originalUrl || req.url, "http://internal");
  url.searchParams.sort();
  return createHash("sha256")
    .update(
      JSON.stringify([
        req.user?.id || "public",
        req.user?.role || "public",
        url.pathname,
        url.search,
      ]),
    )
    .digest("hex");
}
@Injectable()
export class ReadCache implements NestInterceptor {
  private bypassUntil = 0;
  private inflight = new Map<string, Promise<unknown>>();
  constructor(@Inject(RedisConnection) private redis: RedisConnection) {}
  async invalidate() {
    try {
      await this.redis.cacheSet(
        "generation",
        randomUUID(),
        MAX_CACHE_SECONDS + 60,
      );
    } catch {
      this.bypassUntil = Date.now() + MAX_CACHE_SECONDS * 1000;
    }
  }
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return defer(async () => {
      const req = context.switchToHttp().getRequest(),
        res = context.switchToHttp().getResponse();
      if (req.user) res.setHeader("Cache-Control", "private, no-store");
      const path = requestPath(req);
      const writing = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      const gatewayStatus = /^\/api\/payments\/orders\/[^/]+\/status$/.test(
        path,
      );
      // These GETs can reconcile a payment and activate a purchase; never cache them.
      if (writing || gatewayStatus) {
        res.setHeader("Cache-Control", "no-store");
        try {
          return await firstValueFrom(next.handle());
        } finally {
          // Also invalidate on partial-success errors. Auth tokens and analytics events
          // do not change list content; their results are never put in this cache.
          if (
            gatewayStatus ||
            (!path.startsWith("/api/auth/") &&
              !["/api/events/view", "/api/newsletter"].includes(path)) ||
            path === "/api/auth/register" ||
            path === "/api/auth/email/verify"
          )
            await this.invalidate();
        }
      }
      const ttl = req.method === "GET" ? readPolicy(path) : 0;
      if (!ttl) return firstValueFrom(next.handle());
      res.setHeader(
        "Cache-Control",
        req.user ? "private, no-store" : "public, max-age=0, must-revalidate",
      );
      if (req.user) res.vary("Authorization");
      let key: string;
      try {
        if (Date.now() < this.bypassUntil) throw new Error("Cache recovering");
        const generation = (await this.redis.cacheGet("generation")) || "0";
        key = generation + ":" + cacheIdentity(req);
        const saved = await this.redis.cacheGet(key);
        if (saved !== null) {
          res.setHeader("X-Cache", "HIT");
          return JSON.parse(saved);
        }
      } catch {
        res.setHeader("X-Cache", "BYPASS");
        return firstValueFrom(next.handle());
      }
      res.setHeader("X-Cache", "MISS");
      const pending = this.inflight.get(key);
      if (pending) return pending;
      const load = (async () => {
        const value = await firstValueFrom(next.handle());
        try {
          const serialized = JSON.stringify(value);
          if (serialized && Buffer.byteLength(serialized) <= 2 * 1024 * 1024)
            await this.redis.cacheSet(key, serialized, ttl);
        } catch {
          /* Reads remain available when caching fails. */
        }
        return value;
      })();
      this.inflight.set(key, load);
      try {
        return await load;
      } finally {
        this.inflight.delete(key);
      }
    });
  }
}
