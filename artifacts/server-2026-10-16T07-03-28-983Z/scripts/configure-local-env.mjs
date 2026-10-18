import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parse } = createRequire(import.meta.url)("dotenv");
const docker = parse(await readFile(path.join(root, ".env.docker"), "utf8"));
const file = path.join(root, ".env");
let content;
try {
  content = await readFile(file, "utf8");
} catch {
  content = await readFile(path.join(root, ".env.example"), "utf8");
}
const current = parse(content);
function set(key, value) {
  const line = key + "=" + JSON.stringify(value);
  const pattern = new RegExp("^" + key + "=.*$", "m");
  content = pattern.test(content)
    ? content.replace(pattern, () => line)
    : content.trimEnd() + "\n" + line + "\n";
}
set(
  "DATABASE_URL",
  `postgresql://${docker.POSTGRES_USER || "mandisetu"}:${docker.POSTGRES_PASSWORD}@127.0.0.1:${docker.POSTGRES_PORT || 15432}/${docker.POSTGRES_DB || "mandisetu"}`,
);
set(
  "REDIS_URL",
  `redis://:${docker.REDIS_PASSWORD}@127.0.0.1:${docker.REDIS_PORT || 16379}/0`,
);
if (!current.JWT_SECRET || current.JWT_SECRET.length < 32)
  set("JWT_SECRET", randomBytes(48).toString("base64url"));
if (!current.WEB_ORIGINS)
  set(
    "WEB_ORIGINS",
    "http://localhost:3000,http://localhost:3001,http://localhost:3002,https://mandisetu-users.vercel.app,https://mandisetu-sellers.vercel.app",
  );
await writeFile(file, content);
console.log(
  "backend/.env now connects host development to the local PostgreSQL and Redis containers. Existing service credentials were preserved.",
);
