import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { RedisConnection } from "./redis";

export const rateKey = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Express accepts trailing slashes and case variants. Use the matched route so
// those aliases cannot create fresh quotas or bypass the submission rules.
export const requestPath = (req: any) =>
  String(req.route?.path || req.path)
    .replace(/\/+$/, "")
    .toLowerCase();
const namespace = () =>
  process.env.NODE_ENV === "test"
    ? process.env.AUTH_RATE_NAMESPACE || "test"
    : "api";
export function positiveSetting(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
export type LimitRule = { bucket: string; maximum: number; seconds: number };
export function submissionRules(path: string, body: any): LimitRule[] {
  const action = path === "/api/workspace/actions" ? body?.action : undefined;
  if (path === "/api/requirements" || action === "LEAD_CREATE")
    return [
      {
        bucket: "requirements",
        maximum: positiveSetting("RATE_REQUIREMENTS_PER_HOUR", 10),
        seconds: 3600,
      },
      {
        bucket: "requirements-day",
        maximum: positiveSetting("RATE_REQUIREMENTS_PER_DAY", 30),
        seconds: 86400,
      },
    ];
  // General enquiries and product quotes deliberately share a budget.
  if (action === "ENQUIRY_CREATE")
    return [
      {
        bucket: "direct-requests",
        maximum: positiveSetting("RATE_ENQUIRIES_PER_HOUR", 30),
        seconds: 3600,
      },
      {
        bucket: "direct-requests-day",
        maximum: positiveSetting("RATE_ENQUIRIES_PER_DAY", 100),
        seconds: 86400,
      },
      ...(typeof body?.data?.sellerId === "string"
        ? [
            {
              bucket: "recipient:" + rateKey(body.data.sellerId),
              maximum: 1,
              seconds: 10,
            },
          ]
        : []),
    ];
  if (action === "ENQUIRY_RESPONSE")
    return [{ bucket: "responses", maximum: 60, seconds: 3600 }];
  if (action === "CLAIM_CREATE" || action === "PROTECTION_CREATE")
    return [{ bucket: "claims-protection", maximum: 10, seconds: 3600 }];
  if (path === "/api/products" || action === "PRODUCT_CREATE")
    return [{ bucket: "product-create", maximum: 30, seconds: 3600 }];
  if (path.startsWith("/api/files/") && path !== "/api/files")
    return [
      {
        bucket: "uploads",
        maximum: positiveSetting("RATE_UPLOADS_PER_15_MINUTES", 20),
        seconds: 900,
      },
    ];
  if (path === "/api/payments/orders")
    return [{ bucket: "payment-orders", maximum: 20, seconds: 900 }];
  if (/^\/api\/leads\/[^/]+\/unlock$/.test(path))
    return [{ bucket: "lead-unlock", maximum: 30, seconds: 900 }];
  if (path === "/api/contact" || path === "/api/newsletter")
    return [{ bucket: path, maximum: 5, seconds: 3600 }];
  if (path === "/api/feedback" || path === "/api/reviews")
    return [{ bucket: path, maximum: 10, seconds: 3600 }];
  return [];
}
export function rejectLimit(
  res: any,
  retryAfter: number,
  message = "Too many requests. Please try again later.",
): never {
  res.setHeader("Retry-After", String(retryAfter));
  res.setHeader("Cache-Control", "no-store");
  throw new HttpException(
    { statusCode: 429, error: "Too Many Requests", message, retryAfter },
    429,
  );
}
export function exemptTraffic(req: any) {
  const path = requestPath(req);
  return (
    req.method === "OPTIONS" ||
    path === "/api/payments/webhook" ||
    path.startsWith("/api/health") ||
    (path.startsWith("/api/files/public/") &&
      ["GET", "HEAD"].includes(req.method))
  );
}
@Injectable()
export class ApiTrafficLimit implements CanActivate {
  constructor(@Inject(RedisConnection) private redis: RedisConnection) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (exemptTraffic(req)) return true;
    try {
      const result = await this.redis.consume(
        namespace() +
          ":traffic:" +
          rateKey(req.ip || req.socket?.remoteAddress || "unknown"),
        positiveSetting("RATE_IP_REQUESTS_PER_MINUTE", 600),
        60,
      );
      if (!result.allowed)
        rejectLimit(ctx.switchToHttp().getResponse(), result.retryAfter);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new ServiceUnavailableException(
        "Request protection is temporarily unavailable. Please try again later.",
      );
    }
    return true;
  }
}
@Injectable()
export class ApiRateLimit implements CanActivate {
  constructor(@Inject(RedisConnection) private redis: RedisConnection) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest(),
      res = ctx.switchToHttp().getResponse();
    const path = requestPath(req);
    // Gateway retries are verified by signatures and must not share a visitor budget.
    if (exemptTraffic(req)) return true;
    const ip = rateKey(req.ip || req.socket?.remoteAddress || "unknown");
    const scope = req.user ? `user:${req.user.id}` : `ip:${ip}`;
    const prefix = namespace();
    const rules: LimitRule[] = [
      {
        bucket: "requests",
        maximum: positiveSetting("RATE_REQUESTS_PER_MINUTE", 300),
        seconds: 60,
      },
    ];
    if (!["GET", "HEAD"].includes(req.method))
      rules.push(
        {
          bucket: "writes",
          maximum: positiveSetting("RATE_WRITES_PER_MINUTE", 60),
          seconds: 60,
        },
        ...submissionRules(path, req.body),
      );
    try {
      for (const rule of rules) {
        const result = await this.redis.consume(
          `${prefix}:${scope}:${rule.bucket}`,
          rule.maximum,
          rule.seconds,
        );
        if (!result.allowed) rejectLimit(res, result.retryAfter);
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new ServiceUnavailableException(
        "Request protection is temporarily unavailable. Please try again later.",
      );
    }
    return true;
  }
}
