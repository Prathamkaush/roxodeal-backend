import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const base = process.env.API_URL || "http://127.0.0.1:4000/api";
if (process.argv.includes("--expect-unavailable")) {
  const response = await fetch(base + "/health/ready", {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 503);
  console.log("Readiness correctly rejects an unavailable dependency.");
  process.exit(0);
}
async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const ready = await request("/health/ready");
assert.equal(ready.database, "ok");
assert.equal(ready.redis, "ok");
assert.ok((await request("/categories")).length > 0);
const catalogue=await request('/catalogue');
assert.ok(Array.isArray(catalogue.products));
assert.ok(catalogue.plans.length>0);
const unauthorized=await fetch(base+'/workspace');assert.equal(unauthorized.status,401);
console.log('Container smoke test passed: PostgreSQL, Redis, catalogue and authenticated route enforcement.');
