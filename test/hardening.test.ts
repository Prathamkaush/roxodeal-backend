import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpException } from "@nestjs/common";
import { of, throwError, firstValueFrom, defer } from "rxjs";
import {
  ApiRateLimit,
  ApiTrafficLimit,
  submissionRules,
} from "../src/api-rate-limit";
import { AuthRateLimit } from "../src/rate-limit";
import { ReadCache, cacheIdentity, readPolicy } from "../src/read-cache";

function context(path: string, user?: string, method = "GET", body: any = {}) {
  const headers: Record<string, string> = {};
  const req = {
    path,
    originalUrl: path,
    method,
    body,
    ip: "192.0.2.10",
    socket: {},
    ...(user ? { user: { id: user, role: "BUYER" } } : {}),
  };
  const res = {
    setHeader: (k: string, v: string) => (headers[k] = v),
    vary: (v: string) => (headers.Vary = v),
  };
  return {
    req,
    headers,
    ctx: {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as any,
  };
}
function memoryRedis() {
  const values = new Map<string, string>(),
    counts = new Map<string, number>();
  return {
    values,
    counts,
    cacheGet: async (k: string) => values.get(k) ?? null,
    cacheSet: async (k: string, v: string) => {
      values.set(k, v);
    },
    consume: async (k: string, max: number, seconds: number) => {
      const count = (counts.get(k) || 0) + 1;
      counts.set(k, count);
      return {
        allowed: count <= max,
        retryAfter: seconds,
        remaining: Math.max(0, max - count),
      };
    },
    reserveEmailSend: async () => 60,
  };
}
function handler(value: unknown, onRead = () => {}) {
  return {
    handle: () =>
      defer(() => {
        onRead();
        return of(value);
      }),
  };
}

test("requirements share a quota across direct and workspace routes; 429 includes retry timing", async () => {
  const redis = memoryRedis();
  const guard = new ApiRateLimit(redis as any);
  for (let i = 0; i < 10; i++) {
    const c = context(
      i % 2 ? "/api/requirements" : "/api/workspace/actions",
      "buyer",
      "POST",
      { action: "LEAD_CREATE" },
    );
    await guard.canActivate(c.ctx);
  }
  const rejected = context("/api/requirements", "buyer", "POST");
  await assert.rejects(
    () => guard.canActivate(rejected.ctx),
    (e: HttpException) => e.getStatus() === 429,
  );
  assert.equal(rejected.headers["Retry-After"], "3600");
  assert.equal(rejected.headers["Cache-Control"], "no-store");
  await guard.canActivate(
    context("/api/requirements", "another-buyer", "POST").ctx,
  );
});
test("quotes and enquiries share account limits and a per-recipient cooldown", async () => {
  const redis = memoryRedis();
  const guard = new ApiRateLimit(redis as any);
  const send = (kind: string, sellerId: string) =>
    guard.canActivate(
      context("/api/workspace/actions", "buyer", "POST", {
        action: "ENQUIRY_CREATE",
        data: { kind, sellerId },
      }).ctx,
    );
  await send("QUOTE", "seller-a");
  await assert.rejects(
    () => send("ENQUIRY", "seller-a"),
    (e: HttpException) => e.getStatus() === 429,
  );
  for (let i = 0; i < 28; i++)
    await send(i % 2 ? "QUOTE" : "ENQUIRY", "seller-" + i);
  await assert.rejects(
    () => send("QUOTE", "different-seller"),
    (e: HttpException) => e.getStatus() === 429,
  );
  assert.deepEqual(
    submissionRules("/api/workspace/actions", { action: "LEAD_CREATE" }),
    submissionRules("/api/requirements", {}),
  );
});
test("IP protection runs without login, exemptions preserve health/webhooks, Redis failure closes submissions", async () => {
  const guard = new ApiTrafficLimit({
    consume: async () => ({ allowed: false, retryAfter: 42 }),
  } as any);
  const c = context("/api/products");
  await assert.rejects(
    () => guard.canActivate(c.ctx),
    (e: HttpException) => e.getStatus() === 429,
  );
  assert.equal(c.headers["Retry-After"], "42");
  for (const p of [
    "/api/health/ready",
    "/api/payments/webhook",
    "/api/files/public/image.webp",
  ])
    assert.equal(await guard.canActivate(context(p).ctx), true);
  const unavailable = new ApiRateLimit({
    consume: async () => {
      throw Error("offline");
    },
  } as any);
  await assert.rejects(
    () =>
      unavailable.canActivate(
        context("/api/workspace/actions", "u", "POST", {
          action: "ENQUIRY_CREATE",
        }).ctx,
      ),
    (e: HttpException) => e.getStatus() === 503,
  );
});
test("OTP resend protection returns 429 and Retry-After without calling the controller", async () => {
  const guard = new AuthRateLimit(memoryRedis() as any);
  const c = context("/api/auth/email/send", undefined, "POST", {
    email: "Buyer@Example.test",
  });
  await assert.rejects(
    () => guard.canActivate(c.ctx),
    (e: HttpException) => e.getStatus() === 429,
  );
  assert.equal(c.headers["Retry-After"], "60");
});
test("case and trailing-slash aliases cannot bypass submission or OTP quotas", async () => {
  const guard = new ApiRateLimit(memoryRedis() as any);
  for (let i = 0; i < 10; i++)
    await guard.canActivate(context("/API/REQUIREMENTS/", "buyer", "POST").ctx);
  await assert.rejects(
    () => guard.canActivate(context("/api/requirements", "buyer", "POST").ctx),
    (e: HttpException) => e.getStatus() === 429,
  );
  const auth = new AuthRateLimit(memoryRedis() as any);
  await assert.rejects(
    () =>
      auth.canActivate(
        context("/API/AUTH/EMAIL/SEND/", undefined, "POST", {
          email: "buyer@example.test",
        }).ctx,
      ),
    (e: HttpException) => e.getStatus() === 429,
  );
});
test("private caches isolate users, roles and pages; successful mutations invalidate public and private lists", async () => {
  const redis = memoryRedis();
  const cache = new ReadCache(redis as any);
  let reads = 0;
  const read = (c: ReturnType<typeof context>, value: unknown) =>
    firstValueFrom(
      cache.intercept(
        c.ctx,
        handler(value, () => reads++),
      ),
    );
  const a = context("/api/workspace", "a");
  assert.deepEqual(await read(a, { name: "Alice" }), { name: "Alice" });
  assert.equal(a.headers["X-Cache"], "MISS");
  assert.deepEqual(await read(a, { name: "changed" }), { name: "Alice" });
  assert.equal(a.headers["X-Cache"], "HIT");
  assert.equal(reads, 1);
  assert.equal(a.headers["Cache-Control"], "private, no-store");
  assert.equal(a.headers.Vary, "Authorization");
  assert.deepEqual(
    await read(context("/api/workspace", "b"), { name: "Bob" }),
    { name: "Bob" },
  );
  const differentRole = context("/api/workspace", "a");
  differentRole.req.user!.role = "ADMIN";
  assert.notEqual(cacheIdentity(a.req), cacheIdentity(differentRole.req));
  const q1 = context("/api/reviews");
  q1.req.originalUrl += "?page=1&sellerId=s";
  const q2 = context("/api/reviews");
  q2.req.originalUrl += "?sellerId=s&page=1";
  assert.equal(cacheIdentity(q1.req), cacheIdentity(q2.req));
  q2.req.originalUrl = "/api/reviews?page=2&sellerId=s";
  assert.notEqual(cacheIdentity(q1.req), cacheIdentity(q2.req));
  const publicRead = context("/api/reviews");
  await read(publicRead, { items: ["old"] });
  await read(
    context("/api/workspace/actions", "a", "POST", {
      action: "ENQUIRY_CREATE",
    }),
    { ok: true },
  );
  assert.deepEqual(await read(a, { name: "Updated Alice" }), {
    name: "Updated Alice",
  });
  assert.deepEqual(await read(publicRead, { items: ["new"] }), {
    items: ["new"],
  });
});
test("an in-flight read before a mutation cannot refill the new cache generation", async () => {
  const cache = new ReadCache(memoryRedis() as any);
  let release!: (v: unknown) => void;
  const pending = new Promise((resolve) => (release = resolve));
  let started!: () => void;
  const start = new Promise<void>((resolve) => (started = resolve));
  const c = context("/api/catalogue");
  const first = firstValueFrom(
    cache.intercept(c.ctx, {
      handle: () =>
        defer(() => {
          started();
          return pending;
        }),
    }),
  );
  await start;
  await cache.invalidate();
  release({ version: "old" });
  await first;
  const fresh = await firstValueFrom(
    cache.intercept(c.ctx, handler({ version: "new" })),
  );
  assert.deepEqual(fresh, { version: "new" });
});
test("cache faults fall back to reads, errors are never cached, payment reconciliation is always live", async () => {
  const unavailable = new ReadCache({
    cacheGet: async () => {
      throw Error("offline");
    },
    cacheSet: async () => {
      throw Error("offline");
    },
  } as any);
  const c = context("/api/workspace", "u");
  assert.deepEqual(
    await firstValueFrom(unavailable.intercept(c.ctx, handler({ live: true }))),
    { live: true },
  );
  assert.equal(c.headers["X-Cache"], "BYPASS");
  const cache = new ReadCache(memoryRedis() as any);
  const bad = context("/api/reviews");
  await assert.rejects(() =>
    firstValueFrom(
      cache.intercept(bad.ctx, {
        handle: () => throwError(() => Error("database failure")),
      }),
    ),
  );
  assert.deepEqual(
    await firstValueFrom(cache.intercept(bad.ctx, handler(["recovered"]))),
    ["recovered"],
  );
  assert.equal(readPolicy("/api/payments/orders/order/status"), 0);
  assert.equal(readPolicy("/api/files/private/doc"), 0);
  assert.equal(readPolicy("/api/health/ready"), 0);
  let reconciliations = 0;
  const p = context("/api/payments/orders/order/status", "u");
  for (let i = 0; i < 2; i++)
    await firstValueFrom(
      cache.intercept(
        p.ctx,
        handler({ status: "CAPTURED" }, () => reconciliations++),
      ),
    );
  assert.equal(reconciliations, 2);
  assert.equal(p.headers["Cache-Control"], "no-store");
});
