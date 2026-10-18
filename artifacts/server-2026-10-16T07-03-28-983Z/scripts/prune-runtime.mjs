import { readFile, readdir, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
// This build-only operation is deliberately unavailable on developer machines.
if (process.platform !== "linux" || process.cwd() !== "/app")
  throw Error(
    "Runtime pruning is only supported in the /app Linux Docker build",
  );
await readFile("/etc/alpine-release");
const modules = "/app/node_modules";
// Prisma ships the same native query engine in three packages. Keep the
// canonical copy and link only byte-identical copies; CLI migrations still work.
const engines = path.join(modules, "@prisma/engines");
for (const name of await readdir(engines)) {
  if (!name.startsWith("libquery_engine-") || !name.endsWith(".so.node"))
    continue;
  const canonical = path.join(engines, name);
  const bytes = await readFile(canonical);
  for (const dir of ["prisma", ".prisma/client"]) {
    const duplicate = path.join(modules, dir, name);
    let content;
    try {
      content = await readFile(duplicate);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (!content.equals(bytes)) continue;
    await unlink(duplicate);
    await symlink(path.relative(path.dirname(duplicate), canonical), duplicate);
  }
}
// npm can install both glibc and musl optional Sharp binaries. This image is
// Alpine/musl only; the incompatible glibc copies can never be selected here.
const img = path.join(modules, "@img");
for (const name of await readdir(img)) {
  const target = path.join(img, name);
  const pkg = JSON.parse(
    await readFile(path.join(target, "package.json"), "utf8"),
  );
  if (
    pkg.os?.includes("linux") &&
    pkg.libc?.includes("glibc") &&
    !pkg.libc.includes("musl")
  )
    await rm(target, { recursive: true });
}
console.log(
  "Shared identical Prisma engines; excluded incompatible glibc image binaries.",
);
