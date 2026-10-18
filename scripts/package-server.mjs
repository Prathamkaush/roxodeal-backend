import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Every export is new: never delete a directory that might contain server data.
const output = path.join(
  root,
  "artifacts",
  "server-" + new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(output, { recursive: true });
const entries = [
  "src",
  "prisma",
  "Dockerfile",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "compose.yml",
  "compose.prod.yml",
  "compose.dev.yml",
  ".env.example",
  ".env.docker.example",
  "README.md",
  "deploy",
];
for (const name of entries)
  await cp(path.join(root, name), path.join(output, name), { recursive: true });
await mkdir(path.join(output, "scripts"));
for (const name of [
  "setup-docker-env.mjs",
  "backup-local.mjs",
  "configure-local-env.mjs",
  "prune-runtime.mjs",
])
  await cp(
    path.join(root, "scripts", name),
    path.join(output, "scripts", name),
  );
const files = [];
let bytes = 0;
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full);
    else {
      const b = await readFile(full);
      files.push(path.relative(output, full).replaceAll("\\", "/"));
      bytes += b.length;
    }
  }
}
await walk(output);
await writeFile(
  path.join(output, "DEPLOYMENT-CONTENTS.json"),
  JSON.stringify(
    {
      files: files.sort(),
      bytes,
      excluded: [
        ".env",
        ".env.docker",
        "node_modules",
        "dist",
        "uploads",
        "backups",
        "test",
        "diagnostic scripts",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Server source bundle: ${output}\n${files.length} files, ${(bytes / 1024).toFixed(0)} KiB. Provision secrets separately. Build the Docker runtime target; repository tests are deliberately excluded from this deployment copy.`,
);
const archive = output + ".tar.gz";
const packed = spawnSync("tar", ["-czf", archive, "-C", output, "."], {
  encoding: "utf8",
});
if (packed.status === 0) console.log("Upload archive: " + archive);
else
  console.log(
    "Archive tool unavailable; the server source directory is ready to copy.",
  );
