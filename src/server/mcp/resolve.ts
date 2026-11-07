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
  const all = candidates.map((c) => c.label);
  throw new ServiceError("validation", `No ${what} called “${ref}”${where}.${all.length ? ` Options: ${list(all)}.` : ""}`);
}

function nameKeys(...names: (string | null | undefined)[]): string[] {
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
