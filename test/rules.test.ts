import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLeadAvailable } from "../src/lead-rules";
import { verifyWebhook } from "../src/payments";
import { createHmac } from "node:crypto";
test("fifth supplier can unlock; sixth cannot", () => {
  assert.doesNotThrow(() =>
    assertLeadAvailable("PARTIALLY_SOLD", 4, 5, false, true),
  );
  assert.throws(() => assertLeadAvailable("PARTIALLY_SOLD", 5, 5, false, true));
  assert.throws(() => assertLeadAvailable("ACTIVE", 5, 8, false, true));
});
test("duplicate, mismatched category, and inactive leads are rejected", () => {
  assert.throws(() => assertLeadAvailable("ACTIVE", 1, 5, true, true));
  assert.throws(() => assertLeadAvailable("ACTIVE", 1, 5, false, false));
  for (const status of [
    "PENDING",
    "CLOSED",
    "EXPIRED",
    "REJECTED",
    "FULLY_SOLD",
  ])
    assert.throws(() => assertLeadAvailable(status, 0, 5, false, true));
});
test("webhooks verify exact raw bytes and reject malformed or changed signatures", () => {
  const body = Buffer.from('{"event":"payment.captured"}');
  const signature = createHmac("sha256", "test-secret")
    .update(body)
    .digest("hex");
  assert.equal(verifyWebhook(body, signature, "test-secret"), true);
  assert.equal(
    verifyWebhook(Buffer.from("{}"), signature, "test-secret"),
    false,
  );
  assert.equal(verifyWebhook(body, "invalid", "test-secret"), false);
  assert.equal(verifyWebhook(body, signature, "wrong-secret"), false);
});
