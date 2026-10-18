import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../.env.docker", import.meta.url));
const secret = () => randomBytes(32).toString("hex");
try {
  writeFileSync(
    target,
    [
      "POSTGRES_DB=mandisetu",
      "POSTGRES_USER=mandisetu",
      `POSTGRES_PASSWORD=${secret()}`,
      `REDIS_PASSWORD=${secret()}`,
      `JWT_SECRET=${secret()}`,
      "WEB_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:3002,https://mandisetu-users.vercel.app,https://mandisetu-sellers.vercel.app",
      "BACKEND_PORT=4000",
      "POSTGRES_PORT=15432",
      "REDIS_PORT=16379",
      "BACKEND_IMAGE=mandisetu-backend:local",
      "UPLOADS_PATH=/srv/mandisetu/uploads",
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created .env.docker with random secrets. Keep this file private.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing .env.docker preserved.");
}
