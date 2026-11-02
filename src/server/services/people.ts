import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { companies, people, personCompanies, users } from "@/server/db/schema";
import { accessibleCompaniesWhere } from "./access";
import type { ServiceContext } from "./context";

export interface PersonView {
  id: string;
  fullName: string;
  phone: string | null;
  telegramHandle: string | null;
  notes: string | null;
  isUser: boolean;
  roles: { companyId: string; companySlug: string; companyName: string; role: string; title: string | null }[];
}

/** People with their company roles. With `companyId`, only people linked to that company. */
export async function listPeople(ctx: ServiceContext, opts: { companyId?: string } = {}): Promise<PersonView[]> {
  const links = await ctx.db
    .select({
      personId: personCompanies.personId,
      companyId: companies.id,
      companySlug: companies.slug,
      companyName: companies.name,
      role: personCompanies.role,
      title: personCompanies.title,
    })
    .from(personCompanies)
    .innerJoin(companies, eq(companies.id, personCompanies.companyId))
    .where(accessibleCompaniesWhere(ctx))
    .orderBy(asc(companies.sort));

  const personIds = opts.companyId
    ? [...new Set(links.filter((l) => l.companyId === opts.companyId).map((l) => l.personId))]
    : null;
  if (personIds && personIds.length === 0) return [];

  const rows = await ctx.db
    .select()
    .from(people)
    .where(personIds ? inArray(people.id, personIds) : undefined)
    .orderBy(asc(people.fullName));

  return rows.map((p) => ({
    id: p.id,
    fullName: p.fullName,
    phone: p.phone,
    telegramHandle: p.telegramHandle,
    notes: p.notes,
    isUser: p.userId !== null,
    roles: links
      .filter((l) => l.personId === p.id && (!opts.companyId || l.companyId === opts.companyId))
      .map(({ personId: _p, ...rest }) => (void _p, rest)),
  }));
}

/** Founders (app users) for assignee pickers. */
export async function listFounders(ctx: ServiceContext) {
  return ctx.db
    .select({ id: users.id, name: users.name, shortName: users.shortName })
    .from(users)
    .where(and(eq(users.role, "founder")))
    .orderBy(asc(users.shortName));
}

/** People who can be assigned tasks of a company (non-user people linked to it). */
export async function assignablePeopleByCompany(ctx: ServiceContext): Promise<Record<string, { id: string; name: string }[]>> {
  const rows = await ctx.db
    .select({ companyId: personCompanies.companyId, id: people.id, name: people.fullName, userId: people.userId })
    .from(personCompanies)
    .innerJoin(people, eq(people.id, personCompanies.personId))
    .orderBy(asc(people.fullName));
  const out: Record<string, { id: string; name: string }[]> = {};
  for (const r of rows) {
    if (r.userId) continue; // founders are assigned as users
    const list = (out[r.companyId] ??= []);
    if (!list.some((p) => p.id === r.id)) list.push({ id: r.id, name: r.name });
  }
  return out;
}
