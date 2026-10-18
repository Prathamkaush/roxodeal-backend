import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { rejectLimit, requestPath } from "./api-rate-limit";
import { RedisConnection } from "./redis";
@Injectable()
export class AuthRateLimit implements CanActivate {
  constructor(@Inject(RedisConnection) private redis: RedisConnection) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const path = requestPath(req);
    if (
      req.method !== "POST" ||
      !path.startsWith("/api/auth/") ||
      path.endsWith("/refresh") ||
      path.endsWith("/logout")
    )
      return true;
    const namespace =
      process.env.NODE_ENV === "test"
        ? process.env.AUTH_RATE_NAMESPACE || "test"
        : "auth";
    const ip = createHash("sha256")
      .update(req.ip || req.socket.remoteAddress || "unknown")
      .digest("hex");
    try {
      const ipLimit = await this.redis.consume(
        namespace + ":ip:" + ip,
        30,
        900,
      );
      if (!ipLimit.allowed)
        rejectLimit(
          ctx.switchToHttp().getResponse(),
          ipLimit.retryAfter,
          "Too many authentication attempts. Try again later.",
        );
      const identifier = req.body?.email || req.body?.phone;
      if (typeof identifier === "string") {
        const key = createHash("sha256")
          .update(identifier.trim().toLowerCase())
          .digest("hex");
        if (path.endsWith("/email/send") || path.endsWith("/forgot-password")) {
          const purpose = path.endsWith("/email/send")
            ? "verification"
            : "reset";
          const retryAfter = await this.redis.reserveEmailSend(
            namespace + ":" + purpose + ":" + key,
          );
          if (retryAfter > 0) {
            ctx
              .switchToHttp()
              .getResponse()
              .setHeader("Retry-After", String(retryAfter));
            throw new HttpException(
              {
                statusCode: 429,
                message:
                  retryAfter > 60
                    ? "You have reached the hourly email limit. Please try again later."
                    : "Please wait before requesting another email.",
                retryAfter,
              },
              429,
            );
          }
        }
        const accountLimit = await this.redis.consume(
          namespace + ":account:" + key,
          15,
          900,
        );
        if (!accountLimit.allowed)
          rejectLimit(
            ctx.switchToHttp().getResponse(),
            accountLimit.retryAfter,
            "Too many authentication attempts. Try again later.",
          );
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new ServiceUnavailableException(
        "Authentication is temporarily unavailable",
      );
    }
    return true;
  }
}
