import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".data/**",
      "drizzle/**",
      "test-results/**",
      "playwright-report/**",
      "next-env.d.ts",
      // Agent worktrees (other checkouts of this repo) are not part of this project.
      ".claude/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
