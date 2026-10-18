import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  await readFile(path.join(root, "../.npm-cache/live-fixtures.json"), "utf8"),
);
const { parse } = createRequire(import.meta.url)("dotenv");
const cfg = parse(await readFile(path.join(root, ".env.docker"), "utf8"));
const child = spawn(process.execPath, ["dist/main.js"], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: fixture.DATABASE_URL,
    REDIS_URL: fixture.REDIS_URL,
    JWT_SECRET: cfg.JWT_SECRET,
    PORT: "4100",
    NODE_ENV: "test",
    // Browser fixtures are already verified; never inherit real delivery/payment credentials.
    SMTP_HOST: "",
    SMTP_FROM: "",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    SMS_PROVIDER_URL: "",
    SMS_PROVIDER_TOKEN: "",
    RAZORPAY_KEY_ID: "",
    RAZORPAY_KEY_SECRET: "",
    AUTH_RATE_NAMESPACE: "browser-" + Date.now(),
    WEB_ORIGINS:
      "http://localhost:3210,http://localhost:3211,http://localhost:3212",
    PRIVATE_UPLOAD_DIR: path.join(root, "uploads/integration-private"),
    PUBLIC_UPLOAD_DIR: path.join(root, "uploads/integration-public"),
    PUBLIC_FILE_BASE_URL: "http://localhost:4100/api/files/public",
  },
  stdio: "inherit",
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
