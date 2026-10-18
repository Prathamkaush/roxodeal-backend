import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parse } = createRequire(import.meta.url)("dotenv");
const cfg = parse(await readFile(path.join(root, ".env.docker")));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = path.join(root, "backups", stamp);
await mkdir(destination, { recursive: true });
async function archive(args, name) {
  const target = path.join(destination, name);
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += chunk.toString();
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Container backup failed: " + error)),
    );
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(target, { flags: "wx" })),
    finished,
  ]);
  if (!(await stat(target)).size) throw new Error("Empty backup: " + name);
}
await archive(
  [
    "exec",
    process.env.POSTGRES_CONTAINER || "mandisetu-postgres-1",
    "pg_dump",
    "-U",
    cfg.POSTGRES_USER || "mandisetu",
    "-d",
    cfg.POSTGRES_DB || "mandisetu",
    "-Fc",
  ],
  "database.dump",
);
await archive(
  [
    "exec",
    process.env.BACKEND_CONTAINER || "mandisetu-backend-1",
    "tar",
    "-czf",
    "-",
    "-C",
    "/app",
    "uploads",
  ],
  "uploads.tar.gz",
);
console.log("Database and upload backups saved to " + destination);
