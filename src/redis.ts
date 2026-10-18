import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { createClient } from "redis";
import { createHash } from "node:crypto";

@Injectable()
export class RedisConnection implements OnModuleInit, OnModuleDestroy {
  private readonly cacheNamespace =
    process.env.CACHE_NAMESPACE ||
    createHash("sha256")
      .update(process.env.DATABASE_URL || "default")
      .digest("hex")
      .slice(0, 16);
  private readonly logger = new Logger(RedisConnection.name);
  private readonly client = process.env.REDIS_URL
    ? createClient({
        url: process.env.REDIS_URL,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: 5000,
          reconnectStrategy: (retries) =>
            Math.min(250 * 2 ** Math.min(retries, 4), 4000),
        },
      })
    : undefined;

  async onModuleInit() {
    if (!this.client) return;
    this.client.on("error", () =>
      this.logger.error("Redis connection unavailable"),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Redis startup timed out")),
            20000,
          );
        }),
      ]);
    } catch (error) {
      if (this.client.isOpen) this.client.destroy();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async check(): Promise<"ok" | "not_configured"> {
    if (!this.client) return "not_configured";
    if (!this.client.isReady) throw new Error("Redis is not ready");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Redis timed out")), 2000);
        }),
      ]);
      return "ok";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  onModuleDestroy() {
    if (this.client?.isOpen) this.client.destroy();
  }
  async limit(key: string, maximum: number, seconds: number): Promise<boolean> {
    return (await this.consume(key, maximum, seconds)).allowed;
  }
  async consume(
    key: string,
    maximum: number,
    seconds: number,
  ): Promise<{ allowed: boolean; retryAfter: number; remaining: number }> {
    if (!this.client?.isReady) throw new Error("Rate limiting requires Redis");
    const result = (await this.client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('TTL',KEYS[1])}",
      { keys: ["roxodeal:rate:" + key], arguments: [String(seconds)] },
    )) as number[];
    return {
      allowed: Number(result[0]) <= maximum,
      retryAfter: Math.max(1, Number(result[1])),
      remaining: Math.max(0, maximum - Number(result[0])),
    };
  }
  async cacheGet(key: string): Promise<string | null> {
    if (!this.client?.isReady) throw new Error("Cache unavailable");
    return this.client.get("roxodeal:cache:" + this.cacheNamespace + ":" + key);
  }
  async cacheSet(key: string, value: string, seconds: number) {
    if (!this.client?.isReady) throw new Error("Cache unavailable");
    await this.client.set(
      "roxodeal:cache:" + this.cacheNamespace + ":" + key,
      value,
      { EX: seconds },
    );
  }
  async reserveEmailSend(key: string): Promise<number> {
    if (!this.client?.isReady) throw new Error("Rate limiting requires Redis");
    const result = await this.client.eval(
      "local ttl=redis.call('TTL',KEYS[1]); if ttl>0 then return ttl end; local count=tonumber(redis.call('GET',KEYS[2]) or '0'); if count>=5 then return math.max(redis.call('TTL',KEYS[2]),1) end; local n=redis.call('INCR',KEYS[2]); if n==1 then redis.call('EXPIRE',KEYS[2],3600) end; redis.call('SET',KEYS[1],'1','EX',60); return 0",
      {
        keys: [
          "roxodeal:email-send:" + key + ":cooldown",
          "roxodeal:email-send:" + key + ":hour",
        ],
        arguments: [],
      },
    );
    return Number(result);
  }
}
