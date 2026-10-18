import { config } from "dotenv";
import { resolve } from "node:path";

// Both src/ and dist/ are directly inside the backend workspace.
export const environmentFile = resolve(__dirname, "../.env");
config({ path: environmentFile, quiet: true });

export function getJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      `JWT_SECRET is missing. Set it in ${environmentFile} or the process environment. .env.example is a template and is not loaded.`,
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `JWT_SECRET must contain at least 32 characters (received ${secret.length}). Check ${environmentFile} or the process environment.`,
    );
  }
  return secret;
}
