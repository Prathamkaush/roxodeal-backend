import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { environmentFile, getJwtSecret } from "../src/environment";

test("environment file belongs to backend regardless of the working directory", () => {
  assert.equal(environmentFile, resolve(__dirname, "../.env"));
});

test("JWT validation accepts exactly 32 characters and rejects missing or short values", () => {
  assert.equal(getJwtSecret({ JWT_SECRET: "x".repeat(32) }).length, 32);
  assert.throws(() => getJwtSecret({}), /JWT_SECRET is missing/);
  assert.throws(() => getJwtSecret({ JWT_SECRET: "short" }), /received 5/);
});
