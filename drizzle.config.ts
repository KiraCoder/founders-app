import { defineConfig } from "drizzle-kit";

// Only used for `npm run db:generate` (SQL migration files). Migrations are applied
// by scripts/db-migrate.ts so the same files work for PGlite (local) and Postgres (Supabase).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
});
