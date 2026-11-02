import "server-only";
import { and, asc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  linkCreateSchema,
  linkUpdateSchema,
  peopleFiltersSchema,
  personCreateSchema,
  personUpdateSchema,
  type LinkCreateInput,
  type LinkUpdateInput,
  type PeopleFilters,
  type PersonCreateInput,
  personPatchSchema,
  type PersonPatchInput,
  type PersonUpdateInput,
} from "@/lib/people-schemas";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { zonedTimeToUtc } from "@/lib/dates";
import type { Db } from "@/server/db/connect";
import {
  companies,
  companyUnits,
  people,
  personCompanies,
  users,
  type EmploymentType,
} from "@/server/db/schema";
import {
  accessibleCompaniesWhere,
  assertCompanyAccess,
  assertSalaryViewer,
  assertValidId,
  inAccessibleCompany,
  isSalaryViewer,
  visibleLinksWhere,
  visiblePeopleWhere,
} from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { addSalary, currentSalaries, logSalaryAccess, salaryHistory, type SalaryView } from "./salaries";

export interface PersonLinkView {
  id: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  companyColor: string;
  unitId: string | null;
  unitName: string | null;
  role: string;
  title: string | null;
  employmentType: EmploymentType;
  isActive: boolean;
  startedOn: string | null;
  endedOn: string | null;
  /**
   * Current salary. The key exists ONLY for salary viewers when the caller asked for
   * salaries (`salaryScope`); for everyone else it is absent, not just null.
   */
  salary?: SalaryView | null;
  /** Full history, newest first (person page / single-person API; viewers only). */
  salaryHistory?: SalaryView[];
}

export interface PersonView {
  id: string;
  fullName: string;
  shortName: string | null;
  phone: string | null;
  telegramHandle: string | null;
  email: string | null;
  notes: string | null;
  isUser: boolean;
  /** ISO timestamp when the person left the group; null while active. */
  leftAt: string | null;
  /** Company links ("roles"). In a company view, only that company's links. */
  roles: PersonLinkView[];
}

export interface SalaryReadOptions {
  /**
   * Ask for salaries. Honoured only for salary viewers (others silently get none), and
   * logged once per call under this scope (e.g. "people_list", "company:kiwi-go", "api").
   */
  salaryScope?: string;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Search treats ё and е as the same letter ("Алёна" = "Алена"). */
const yoToE = (s: string) => s.replace(/ё/g, "е").replace(/Ё/g, "Е");
const yoInsensitiveLike = (column: AnyPgColumn, pattern: string): SQL =>
  sql`translate(coalesce(${column}, ''), 'ёЁ', 'еЕ') ilike ${pattern}`;

async function loadLinks(ctx: ServiceContext, personIds: string[] | null, where?: SQL): Promise<(PersonLinkView & { personId: string })[]> {
  if (personIds && personIds.length === 0) return [];
  return ctx.db
    .select({
      id: personCompanies.id,
      personId: personCompanies.personId,
      companyId: companies.id,
      companySlug: companies.slug,
      companyName: companies.name,
      companyColor: companies.color,
      unitId: personCompanies.unitId,
      unitName: companyUnits.name,
      role: personCompanies.role,
      title: personCompanies.title,
      employmentType: personCompanies.employmentType,
      isActive: personCompanies.isActive,
      startedOn: personCompanies.startedOn,
      endedOn: personCompanies.endedOn,
    })
    .from(personCompanies)
    .innerJoin(companies, eq(companies.id, personCompanies.companyId))
    .leftJoin(companyUnits, eq(companyUnits.id, personCompanies.unitId))
    .where(
      and(
        accessibleCompaniesWhere(ctx),
        personIds ? inArray(personCompanies.personId, personIds) : undefined,
        where,
      ),
    )
    .orderBy(asc(companies.sort), asc(personCompanies.createdAt));
}

/** Attaches current salaries (viewers only) and writes ONE audit row for the call. */
async function attachSalaries(
  ctx: ServiceContext,
  list: PersonView[],
  opts: SalaryReadOptions & { history?: boolean; personId?: string },
): Promise<void> {
  if (!opts.salaryScope || !(await isSalaryViewer(ctx))) return;
  const linkIds = list.flatMap((p) => p.roles.map((r) => r.id));
  const current = await currentSalaries(ctx, linkIds);
  const history = opts.history ? await salaryHistory(ctx, linkIds) : null;
  for (const p of list) {
    for (const r of p.roles) {
      r.salary = current.get(r.id) ?? null;
      if (history) r.salaryHistory = history.get(r.id) ?? [];
    }
  }
  await logSalaryAccess(ctx, {
    action: "view",
    scope: opts.salaryScope,
    personId: opts.personId ?? null,
    details: { people: list.length },
  });
}

function toPersonView(p: typeof people.$inferSelect, roles: PersonLinkView[]): PersonView {
  return {
    id: p.id,
    fullName: p.fullName,
    shortName: p.shortName,
    phone: p.phone,
    telegramHandle: p.telegramHandle,
    email: p.email,
    notes: p.notes,
    isUser: p.userId !== null,
    leftAt: p.leftAt ? p.leftAt.toISOString() : null,
    roles,
  };
}

/**
 * People with their company links.
 * - `status` (default "active"): active = not marked as left (and, with a company filter,
 *   still active in that company); "left" = left the group or that company; "all".
 * - `companyId` / `unitId`: only people linked there; `roles` then shows only those links.
 * - `q`: name, short name, phone, Telegram, email, role or title. Never salaries.
 */
export async function listPeople(
  ctx: ServiceContext,
  rawFilters: PeopleFilters = {},
  opts: SalaryReadOptions = {},
): Promise<PersonView[]> {
  const f = peopleFiltersSchema.parse(rawFilters);
  const status = f.status ?? "active";
  const companyId = f.companyId ?? null;
  const unitId = f.unitId ?? null;

  const linkWhere = and(
    companyId ? eq(personCompanies.companyId, companyId) : undefined,
    unitId ? eq(personCompanies.unitId, unitId) : undefined,
  );
  const scoped = companyId || unitId ? await loadLinks(ctx, null, linkWhere) : null;
  let candidateIds: string[] | null = null;
  if (scoped) {
    const keep = scoped.filter((l) => (status === "active" ? l.isActive : status === "left" ? !l.isActive : true));
    candidateIds = [...new Set(keep.map((l) => l.personId))];
    if (candidateIds.length === 0) return [];
  }

  let qWhere: SQL | undefined;
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`;
    const yoPattern = `%${escapeLike(yoToE(f.q))}%`;
    const digits = f.q.replace(/\D/g, "");
    qWhere = or(
      yoInsensitiveLike(people.fullName, yoPattern),
      yoInsensitiveLike(people.shortName, yoPattern),
      ilike(people.phone, pattern),
      ilike(people.telegramHandle, `%${escapeLike(f.q.replace(/^@/, ""))}%`),
      ilike(people.email, pattern),
      digits.length >= 4 ? sql`regexp_replace(coalesce(${people.phone}, ''), '[^0-9]', '', 'g') like ${`%${digits}%`}` : undefined,
      inArray(
        people.id,
        ctx.db
          .select({ id: personCompanies.personId })
          .from(personCompanies)
          .where(
            and(
              visibleLinksWhere(ctx),
              or(yoInsensitiveLike(personCompanies.role, yoPattern), yoInsensitiveLike(personCompanies.title, yoPattern)),
            ),
          ),
      ),
    );
  }

  const statusWhere =
    scoped || status === "all"
      ? // In a company view the link decides "left" (see above); a person who left the
        // group is still hidden from the active list.
        status === "active"
        ? isNull(people.leftAt)
        : undefined
      : status === "active"
        ? isNull(people.leftAt)
        : isNotNull(people.leftAt);

  const rows = await ctx.db
    .select()
    .from(people)
    .where(and(visiblePeopleWhere(ctx), candidateIds ? inArray(people.id, candidateIds) : undefined, statusWhere, qWhere))
    .orderBy(asc(people.fullName))
    .limit(f.limit ?? 1000);

  const links = scoped ?? (await loadLinks(ctx, rows.map((r) => r.id)));
  const byPerson = new Map<string, PersonLinkView[]>();
  for (const { personId, ...l } of links) {
    if (scoped && status === "active" && !l.isActive) continue;
    if (scoped && status === "left" && l.isActive) continue;
    (byPerson.get(personId) ?? byPerson.set(personId, []).get(personId)!).push(l);
  }
  const list = rows.map((p) => toPersonView(p, byPerson.get(p.id) ?? []));
  await attachSalaries(ctx, list, opts);
  return list;
}

/** One person with ALL their company links (active and ended). */
export async function getPerson(ctx: ServiceContext, id: string, opts: SalaryReadOptions = {}): Promise<PersonView> {
  assertValidId(id, "Person");
  const [row] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.id, id), visiblePeopleWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Person not found");
  const links = (await loadLinks(ctx, [id])).map(({ personId: _p, ...l }) => (void _p, l));
  const view = toPersonView(row, links);
  await attachSalaries(ctx, [view], { ...opts, history: true, personId: id });
  return view;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

type Tx = Db;
async function inTx<T>(ctx: ServiceContext, fn: (tx: ServiceContext) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => fn({ ...ctx, db: tx as unknown as Tx }));
}

async function assertUnitInCompany(ctx: ServiceContext, unitId: string | null | undefined, companyId: string) {
  if (!unitId) return;
  const [u] = await ctx.db
    .select({ id: companyUnits.id })
    .from(companyUnits)
    .where(and(eq(companyUnits.id, unitId), eq(companyUnits.companyId, companyId)));
  if (!u) throw new ServiceError("validation", "Unit does not belong to this company", { unitId: ["Unit does not belong to this company"] });
}

async function loadVisibleLink(ctx: ServiceContext, linkId: string) {
  assertValidId(linkId, "Company link");
  const [link] = await ctx.db
    .select()
    .from(personCompanies)
    .where(and(eq(personCompanies.id, linkId), visibleLinksWhere(ctx)));
  if (!link) throw new ServiceError("not_found", "Company link not found");
  return link;
}

async function insertLink(ctx: ServiceContext, personId: string, input: LinkCreateInput, scope: string): Promise<string> {
  const data = linkCreateSchema.parse(input);
  await assertCompanyAccess(ctx, data.companyId);
  await assertUnitInCompany(ctx, data.unitId, data.companyId);
  const [dupe] = await ctx.db
    .select({ id: personCompanies.id })
    .from(personCompanies)
    .where(
      and(
        eq(personCompanies.personId, personId),
        eq(personCompanies.companyId, data.companyId),
        eq(personCompanies.role, data.role),
      ),
    );
  if (dupe) throw new ServiceError("conflict", "This person already has this role in this company");
  const isActive = data.isActive ?? true;
  const [row] = await ctx.db
    .insert(personCompanies)
    .values({
      personId,
      companyId: data.companyId,
      unitId: data.unitId ?? null,
      role: data.role,
      title: data.title ?? null,
      employmentType: data.employmentType ?? "staff",
      isActive,
      startedOn: data.startedOn ?? null,
      endedOn: data.endedOn ?? (isActive ? null : today(ctx)),
    })
    .returning({ id: personCompanies.id });
  if (data.salary) await addSalary(ctx, row!.id, data.salary, scope);
  return row!.id;
}

/** Creates a person, optionally with company links (and salaries, for viewers only). */
export async function createPerson(ctx: ServiceContext, input: PersonCreateInput, scope = "person"): Promise<PersonView> {
  const data = personCreateSchema.parse(input);
  // Check salary permission before writing anything.
  if (data.links?.some((l) => l.salary)) await assertSalaryViewer(ctx);
  for (const l of data.links ?? []) await assertCompanyAccess(ctx, l.companyId);

  const id = await inTx(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(people)
      .values({
        fullName: data.fullName,
        shortName: data.shortName ?? null,
        phone: data.phone ?? null,
        telegramHandle: data.telegramHandle ?? null,
        email: data.email ?? null,
        notes: data.notes ?? null,
      })
      .returning({ id: people.id });
    for (const l of data.links ?? []) await insertLink(tx, row!.id, l, scope);
    return row!.id;
  });
  return getPerson(ctx, id);
}

/** Edits person fields; `status: "left"` marks the person as left (see markPersonLeft). */
export async function updatePerson(ctx: ServiceContext, id: string, input: PersonUpdateInput): Promise<PersonView> {
  const data = personUpdateSchema.parse(input);
  await getPerson(ctx, id); // visibility + not_found
  const { status, leftOn, ...fields } = data;
  if (leftOn && leftOn > today(ctx)) {
    throw new ServiceError("validation", "The leaving date can't be in the future", { leftOn: ["Can't be in the future"] });
  }
  await inTx(ctx, async (tx) => {
    if (Object.keys(fields).length > 0) {
      await tx.db
        .update(people)
        .set({ ...fields, updatedAt: ctx.now })
        .where(eq(people.id, id));
    }
    if (status === "left") await markLeft(tx, id, leftOn ?? null);
    if (status === "active") await undoLeft(tx, id);
  });
  return getPerson(ctx, id);
}

/**
 * Marks a person as left on `leftOn` (default today, Asia/Bishkek): `left_at` is that
 * day (start of day, or now for today) and every active company link is ended on that
 * date and flagged `ended_by_leave`. Already left: nothing changes.
 */
async function markLeft(ctx: ServiceContext, id: string, leftOn: string | null) {
  const t = today(ctx);
  const endedOn = leftOn ?? t;
  const leftAt = endedOn === t ? ctx.now : zonedTimeToUtc(endedOn, "00:00", ctx.timeZone);
  const changed = await ctx.db
    .update(people)
    .set({ leftAt, updatedAt: ctx.now })
    .where(and(eq(people.id, id), isNull(people.leftAt)))
    .returning({ id: people.id });
  if (changed.length === 0) return;
  await ctx.db
    .update(personCompanies)
    .set({ isActive: false, endedOn, endedByLeave: true, updatedAt: ctx.now })
    .where(and(eq(personCompanies.personId, id), eq(personCompanies.isActive, true), visibleLinksWhere(ctx)));
}

/**
 * Undo "left": the person is active again and exactly the links that "mark as left"
 * ended come back (active, no end date). Links ended by hand stay ended.
 */
async function undoLeft(ctx: ServiceContext, id: string) {
  await ctx.db.update(people).set({ leftAt: null, updatedAt: ctx.now }).where(eq(people.id, id));
  await ctx.db
    .update(personCompanies)
    .set({ isActive: true, endedOn: null, endedByLeave: false, updatedAt: ctx.now })
    .where(and(eq(personCompanies.personId, id), eq(personCompanies.endedByLeave, true), visibleLinksWhere(ctx)));
}

/**
 * "Mark as left": no hard delete. The person disappears from active lists; their links
 * are ended (is_active=false, ended_on) and all history (salaries, tasks) is kept.
 */
export async function markPersonLeft(ctx: ServiceContext, id: string, leftOn?: string | null): Promise<PersonView> {
  return updatePerson(ctx, id, { status: "left", leftOn: leftOn ?? null });
}

export async function addPersonLink(ctx: ServiceContext, personId: string, input: LinkCreateInput, scope = "person"): Promise<PersonView> {
  await getPerson(ctx, personId);
  const data = linkCreateSchema.parse(input);
  if (data.salary) await assertSalaryViewer(ctx);
  await inTx(ctx, (tx) => insertLink(tx, personId, data, scope));
  return getPerson(ctx, personId);
}

/** Edits a link. Setting `isActive: false` ends it (ended_on defaults to today). */
export async function updatePersonLink(ctx: ServiceContext, linkId: string, input: LinkUpdateInput): Promise<PersonView> {
  const link = await loadVisibleLink(ctx, linkId);
  const data = linkUpdateSchema.parse(input);
  if (data.unitId !== undefined) await assertUnitInCompany(ctx, data.unitId, link.companyId);
  if (data.role && data.role !== link.role) {
    const [dupe] = await ctx.db
      .select({ id: personCompanies.id })
      .from(personCompanies)
      .where(
        and(
          eq(personCompanies.personId, link.personId),
          eq(personCompanies.companyId, link.companyId),
          eq(personCompanies.role, data.role),
        ),
      );
    if (dupe) throw new ServiceError("conflict", "This person already has this role in this company");
  }
  // A link edited by hand is no longer "ended by mark as left" (undo leaves it alone).
  const set: Partial<typeof personCompanies.$inferInsert> = { updatedAt: ctx.now, endedByLeave: false };
  if (data.unitId !== undefined) set.unitId = data.unitId;
  if (data.role !== undefined) set.role = data.role;
  if (data.title !== undefined) set.title = data.title;
  if (data.employmentType) set.employmentType = data.employmentType;
  if (data.startedOn !== undefined) set.startedOn = data.startedOn;
  if (data.endedOn !== undefined) set.endedOn = data.endedOn;
  if (data.isActive !== undefined) {
    set.isActive = data.isActive;
    if (!data.isActive && data.endedOn === undefined) set.endedOn = link.endedOn ?? today(ctx);
    if (data.isActive && data.endedOn === undefined) set.endedOn = null;
  }
  await inTx(ctx, async (tx) => {
    await tx.db.update(personCompanies).set(set).where(eq(personCompanies.id, linkId));
    if (data.isActive) {
      // Re-activating a link brings the person back to the active lists.
      await tx.db.update(people).set({ leftAt: null, updatedAt: ctx.now }).where(eq(people.id, link.personId));
    }
  });
  return getPerson(ctx, link.personId);
}

/** Adds a salary change for a link and returns the person (viewer only; audited). */
export async function addPersonSalary(
  ctx: ServiceContext,
  linkId: string,
  input: Parameters<typeof addSalary>[2],
  scope = "person",
): Promise<PersonView> {
  await assertSalaryViewer(ctx);
  const link = await loadVisibleLink(ctx, linkId);
  await addSalary(ctx, linkId, input, scope); // salary row + audit row in one transaction
  return getPerson(ctx, link.personId);
}

/**
 * One PATCH of the REST API (`/api/v1/people/:id`): person fields, new links, link edits
 * and salary rows, ALL in one transaction. Everything is checked before anything is
 * written (salary permission, link ids belong to this person, no duplicate link + date
 * salaries), and any later failure rolls the whole request back.
 */
export async function patchPerson(ctx: ServiceContext, id: string, rawInput: PersonPatchInput): Promise<PersonView> {
  const input = personPatchSchema.parse(rawInput);
  if (input.addSalaries?.length || input.addLinks?.some((l) => l.salary)) await assertSalaryViewer(ctx);
  const before = await getPerson(ctx, id);
  const linkIds = new Set(before.roles.map((r) => r.id));
  for (const u of input.updateLinks ?? []) {
    if (!linkIds.has(u.id)) throw new ServiceError("not_found", "Company link not found");
  }
  const seen = new Set<string>();
  for (const s of input.addSalaries ?? []) {
    if (!linkIds.has(s.linkId)) throw new ServiceError("not_found", "Company link not found");
    const key = `${s.linkId}|${s.salary.effectiveFrom ?? today(ctx)}`;
    if (seen.has(key)) {
      throw new ServiceError("validation", "Two salaries for the same role and date in one request; send one");
    }
    seen.add(key);
  }
  await inTx(ctx, async (tx) => {
    if (input.person) await updatePerson(tx, id, input.person);
    for (const l of input.addLinks ?? []) await addPersonLink(tx, id, l, "api");
    for (const u of input.updateLinks ?? []) await updatePersonLink(tx, u.id, u.changes);
    for (const s of input.addSalaries ?? []) await addSalary(tx, s.linkId, s.salary, "api");
  });
  return getPerson(ctx, id, { salaryScope: "api" });
}

// ---------------------------------------------------------------------------
// Company view helpers
// ---------------------------------------------------------------------------

export interface Headcount {
  total: number;
  byUnit: { unitId: string | null; unitName: string; count: number }[];
}

/**
 * Active people per unit of a company. Founders (people with an app account,
 * `people.user_id` set) are not counted: they are linked to every company and would
 * inflate every headcount. Their role text does not matter.
 */
export async function companyHeadcount(ctx: ServiceContext, companyId: string): Promise<Headcount> {
  await assertCompanyAccess(ctx, companyId);
  const [units, rows] = await Promise.all([
    ctx.db
      .select({ id: companyUnits.id, name: companyUnits.name })
      .from(companyUnits)
      .where(and(eq(companyUnits.companyId, companyId), isNull(companyUnits.archivedAt)))
      .orderBy(asc(companyUnits.sort)),
    ctx.db
      .select({ personId: personCompanies.personId, unitId: personCompanies.unitId })
      .from(personCompanies)
      .innerJoin(people, eq(people.id, personCompanies.personId))
      .where(
        and(
          eq(personCompanies.companyId, companyId),
          eq(personCompanies.isActive, true),
          isNull(people.leftAt),
          isNull(people.userId),
          visibleLinksWhere(ctx),
        ),
      ),
  ]);

  const perUnit = new Map<string | null, Set<string>>();
  for (const r of rows) (perUnit.get(r.unitId) ?? perUnit.set(r.unitId, new Set()).get(r.unitId)!).add(r.personId);
  const byUnit: Headcount["byUnit"] = units.map((u) => ({ unitId: u.id, unitName: u.name, count: perUnit.get(u.id)?.size ?? 0 }));
  const noUnit = perUnit.get(null)?.size ?? 0;
  if (noUnit > 0 || units.length === 0) byUnit.push({ unitId: null, unitName: units.length ? "No unit" : "All", count: noUnit });
  return { total: new Set(rows.map((r) => r.personId)).size, byUnit };
}

/** Companies + units for pickers (filters, link forms, importer). */
export async function listCompanyUnitOptions(ctx: ServiceContext) {
  const [cs, us] = await Promise.all([
    ctx.db
      .select({ id: companies.id, slug: companies.slug, name: companies.name, legalName: companies.legalName })
      .from(companies)
      .where(and(isNull(companies.archivedAt), accessibleCompaniesWhere(ctx)))
      .orderBy(asc(companies.sort)),
    ctx.db
      .select({ id: companyUnits.id, companyId: companyUnits.companyId, slug: companyUnits.slug, name: companyUnits.name })
      .from(companyUnits)
      .where(and(isNull(companyUnits.archivedAt), inAccessibleCompany(ctx, companyUnits.companyId)))
      .orderBy(asc(companyUnits.sort)),
  ]);
  return cs.map((c) => ({ ...c, units: us.filter((u) => u.companyId === c.id) }));
}
export type CompanyUnitOption = Awaited<ReturnType<typeof listCompanyUnitOptions>>[number];

// ---------------------------------------------------------------------------
// Pickers used by tasks
// ---------------------------------------------------------------------------

/** Founders (app users) for assignee pickers. */
export async function listFounders(ctx: ServiceContext) {
  return ctx.db
    .select({ id: users.id, name: users.name, shortName: users.shortName })
    .from(users)
    .where(and(eq(users.role, "founder")))
    .orderBy(asc(users.shortName));
}

/** People who can be assigned tasks of a company (active, non-user people linked to it). */
export async function assignablePeopleByCompany(ctx: ServiceContext): Promise<Record<string, { id: string; name: string }[]>> {
  const rows = await ctx.db
    .select({ companyId: personCompanies.companyId, id: people.id, name: people.fullName, userId: people.userId })
    .from(personCompanies)
    .innerJoin(people, eq(people.id, personCompanies.personId))
    .where(and(inAccessibleCompany(ctx, personCompanies.companyId), eq(personCompanies.isActive, true), isNull(people.leftAt)))
    .orderBy(asc(people.fullName));
  const out: Record<string, { id: string; name: string }[]> = {};
  for (const r of rows) {
    if (r.userId) continue; // founders are assigned as users
    const list = (out[r.companyId] ??= []);
    if (!list.some((p) => p.id === r.id)) list.push({ id: r.id, name: r.name });
  }
  return out;
}
