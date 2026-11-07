import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { people, personCompanies } from "@/server/db/schema";
import { inAccessibleCompany } from "@/server/services/access";
import { listCompanies } from "@/server/services/companies";
import type { ServiceContext } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { listFounders } from "@/server/services/people";
import { listProjects } from "@/server/services/projects";

/**
 * Turns the names Claude passes ("Kiwi Go", "Aibek", "Nuraaly", "me") into ids, through the
 * normal services (so only what the founder can see is ever matched). Exact matches win (id,
 * slug, full name, short name, or one word of the name); otherwise a unique partial match. When
 * several candidates fit, or none, the error lists the candidates so Claude can ask back.
 */

export function normalizeName(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[-_.,'’"“”«»()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Candidate<T> {
  value: T;
  label: string;
  /** Normalized names that count as an exact match. */
  keys: string[];
}

const MAX_LISTED = 25;

function list(labels: string[]): string {
  const shown = labels.slice(0, MAX_LISTED).map((l) => `“${l}”`).join(", ");
  return labels.length > MAX_LISTED ? `${shown} (+${labels.length - MAX_LISTED} more)` : shown;
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e",
  ю: "yu", я: "ya", ө: "o", ү: "u", ң: "n", қ: "k", ғ: "g", ұ: "u", ә: "a", і: "i",
};

/** Cyrillic (Russian / Kyrgyz) → Latin, roughly; enough to compare names. */
export function translit(s: string): string {
  return [...s].map((ch) => TRANSLIT[ch] ?? ch).join("");
}

/** Levenshtein distance, capped (stops early above `max`). */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Candidates whose name (or a word of it) is within a small edit distance of `ref`; the closest ones. */
function fuzzyMatches<T>(r: string, candidates: Candidate<T>[]): Candidate<T>[] {
  const ref = translit(r);
  if (ref.length < 3) return [];
  const allowed = ref.length <= 4 ? 1 : 2;
  let best = allowed + 1;
  let out: Candidate<T>[] = [];
  for (const c of candidates) {
    let d = allowed + 1;
    for (const k of c.keys) {
      const key = translit(k);
      if (key.includes(ref) || (ref.length >= 4 && key.startsWith(ref.slice(0, -1)))) d = Math.min(d, 0);
      else d = Math.min(d, editDistance(ref, key, allowed));
    }
    if (d < best) {
      best = d;
      out = [c];
    } else if (d === best && d <= allowed) out.push(c);
  }
  return best <= allowed ? out : [];
}

export function pickOne<T>(ref: string, candidates: Candidate<T>[], what: string, where = ""): T {
  const r = normalizeName(ref);
  if (!r) throw new ServiceError("validation", `Give a ${what} name`);
  const plural = what.endsWith("y") ? `${what.slice(0, -1)}ies` : `${what}s`;
  const exact = candidates.filter((c) => c.keys.includes(r));
  if (exact.length === 1) return exact[0]!.value;
  if (exact.length > 1) {
    throw new ServiceError("validation", `“${ref}” matches several ${plural}${where}: ${list(exact.map((c) => c.label))}. Ask which one is meant and pass the full name.`);
  }
  const partial = candidates.filter((c) => c.keys.some((k) => k.includes(r)));
  if (partial.length === 1) return partial[0]!.value;
  if (partial.length > 1) {
    throw new ServiceError("validation", `“${ref}” matches several ${plural}${where}: ${list(partial.map((c) => c.label))}. Ask which one is meant and pass the full name.`);
  }
  // Typos and Cyrillic spellings ("асан", "Elmrat"): transliterate, then the closest name word.
  const fuzzy = fuzzyMatches(r, candidates);
  if (fuzzy.length === 1) return fuzzy[0]!.value;
  if (fuzzy.length > 1) {
    throw new ServiceError("validation", `“${ref}” matches several ${plural}${where}: ${list(fuzzy.map((c) => c.label))}. Ask which one is meant and pass the full name.`);
  }
  const all = candidates.map((c) => c.label);
  throw new ServiceError("validation", `No ${what} called “${ref}”${where}.${all.length ? ` Options: ${list(all)}.` : ""}`);
}

export function nameKeys(...names: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    const full = normalizeName(n);
    if (!full) continue;
    keys.add(full);
    for (const w of full.split(" ")) if (w.length >= 2) keys.add(w);
  }
  return [...keys];
}

export interface CompanyRef {
  id: string;
  slug: string;
  name: string;
}

export async function resolveCompany(ctx: ServiceContext, ref: string): Promise<CompanyRef> {
  const rows = await listCompanies(ctx);
  return pickOne(
    ref,
    rows.map((c) => ({ value: { id: c.id, slug: c.slug, name: c.name }, label: c.name, keys: [c.id, normalizeName(c.slug), normalizeName(c.name)] })),
    "company",
  );
}

export interface ProjectRef {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
}

export async function resolveProject(ctx: ServiceContext, ref: string, companyId?: string): Promise<ProjectRef> {
  const rows = await listProjects(ctx, companyId ? { companyId } : {});
  return pickOne(
    ref,
    rows.map((p) => ({
      value: { id: p.id, name: p.name, companyId: p.companyId, companyName: p.companyName },
      label: companyId ? p.name : `${p.name} (${p.companyName})`,
      keys: [p.id, normalizeName(p.name)],
    })),
    "project",
    "",
  );
}

export type AssigneeRef = { kind: "user"; id: string; name: string } | { kind: "person"; id: string; name: string };

const ME = new Set(["me", "myself", "i", "self", "мне", "я"]);

/** Active, non-founder people linked to the company (or to any accessible company). */
async function assignablePeople(ctx: ServiceContext, companyId: string | null) {
  const rows = await ctx.db
    .select({ id: people.id, fullName: people.fullName, shortName: people.shortName, userId: people.userId, role: personCompanies.role })
    .from(personCompanies)
    .innerJoin(people, eq(people.id, personCompanies.personId))
    .where(
      and(
        inAccessibleCompany(ctx, personCompanies.companyId),
        companyId ? eq(personCompanies.companyId, companyId) : undefined,
        eq(personCompanies.isActive, true),
        isNull(people.leftAt),
      ),
    )
    .orderBy(asc(people.fullName));
  const seen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!r.userId && !seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

/**
 * A founder (anywhere) or a person working for `companyId`. `companyId` null (a personal todo):
 * founders only. `companyId` "any": people of every accessible company (list filters).
 */
export async function resolveAssignee(ctx: ServiceContext, ref: string, companyId: string | null | "any", companyName?: string): Promise<AssigneeRef> {
  if (ME.has(normalizeName(ref))) return { kind: "user", id: ctx.user.id, name: ctx.user.shortName };
  const founders = await listFounders(ctx);
  const persons = companyId === null ? [] : await assignablePeople(ctx, companyId === "any" ? null : companyId);
  const candidates: Candidate<AssigneeRef>[] = [
    ...founders.map((f) => ({
      value: { kind: "user" as const, id: f.id, name: f.shortName },
      label: `${f.shortName} (founder)`,
      keys: [f.id, ...nameKeys(f.name, f.shortName)],
    })),
    ...persons.map((p) => ({
      value: { kind: "person" as const, id: p.id, name: p.fullName },
      label: `${p.fullName}${p.role ? `, ${p.role}` : ""}`,
      keys: [p.id, ...nameKeys(p.fullName, p.shortName)],
    })),
  ];
  const where = companyId === null ? " (a personal todo can only be yours)" : companyName ? ` at ${companyName}` : "";
  return pickOne(ref, candidates, "assignee", where);
}
