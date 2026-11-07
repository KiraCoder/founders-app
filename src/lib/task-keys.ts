/**
 * Task keys like Linear (0034): <prefix>-<number>, e.g. UPS-1583. The prefix is the company's
 * (Settings → Companies, default 3 letters of the slug); personal todos without a company use
 * "ME" (numbered per founder). Pure: shared by services and the UI.
 */
import { z } from "zod";

export const PERSONAL_PREFIX = "ME";
export const TASK_PREFIX_RE = /^[A-Z][A-Z0-9]{1,5}$/;

export const taskPrefixSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .refine((s) => TASK_PREFIX_RE.test(s), { message: "2–6 letters or digits, starting with a letter (e.g. UPS)" })
  .refine((s) => s !== PERSONAL_PREFIX, { message: `"${PERSONAL_PREFIX}" is kept for personal todos` });

function slugWords(slug: string): string[] {
  return slug
    .replace(/[^A-Za-z-]/g, "")
    .toUpperCase()
    .split(/-+/)
    .filter(Boolean);
}

/**
 * The default prefix of a company: the slug's first 3 letters (upsell-group → UPS). When it is
 * taken: 2 letters + the next word's first (alura-style → ALS), then a digit (ALU2). Same rule
 * as migration 0034.
 */
export function prefixFromSlug(slug: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((t) => t.toUpperCase()));
  used.add(PERSONAL_PREFIX);
  const words = slugWords(slug);
  let base = words.join("").slice(0, 3);
  if (base.length < 2) base = `CO${base}`;
  let cand = base;
  if (used.has(cand) && words.length > 1) cand = `${words[0]!.slice(0, 2)}${words[1]!.slice(0, 1)}`;
  for (let i = 2; used.has(cand); i++) cand = `${base.slice(0, 3)}${i}`;
  return cand;
}

export function taskKey(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

/** "ups-1583" / "UPS-1583" → { prefix: "UPS", number: 1583 }; anything else → null. */
export function parseTaskKey(text: string): { prefix: string; number: number } | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,7})\s*$/.exec(text);
  if (!m) return null;
  return { prefix: m[1]!.toUpperCase(), number: Number(m[2]) };
}
