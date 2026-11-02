/** Loads .env.local / .env for CLI scripts (Next.js does this itself for the app). */
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
