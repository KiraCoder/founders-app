/**
 * Seed data: the two founders, the group's companies, a few people and (opt-in)
 * clearly-marked "[sample]" projects/tasks. Safe to run more than once (upserts by
 * email/slug; existing founders keep their password unless `resetPasswords`; sample
 * tasks are only inserted when none exist yet). See seed-config.ts for the CLI rules.
 *
 * Used by `npm run db:seed` and by tests (no "server-only" on purpose).
 */
import bcrypt from "bcryptjs";
import { eq, like } from "drizzle-orm";
import { addDays, todayInTimeZone } from "@/lib/dates";
import type { Db } from "./connect";
import {
  companies,
  companyUnits,
  people,
  personCompanies,
  projects,
  sessions,
  tasks,
  users,
} from "./schema";

export const FOUNDERS = [
  {
    key: "nuraaly",
    email: "nuraaly@founders.local",
    name: "Nuraaly Toktonazar uulu",
    shortName: "Nuraaly",
  },
  {
    key: "talant",
    email: "talant@founders.local",
    name: "Talantbek Zhenishbek uulu",
    shortName: "Talant",
  },
] as const;

export const DEV_PASSWORD_DEFAULT = "founders-dev-2026";

type CompanySeed = typeof companies.$inferInsert & {
  units?: { slug: string; name: string; kind: string; sort: number }[];
};

export const COMPANY_SEED: CompanySeed[] = [
  {
    slug: "kiwi-go",
    name: "Kiwi Go",
    legalName: "ОсОО KiwiKG",
    kind: "operating",
    description:
      "Courier delivery startup in Osh: intercity (Bishkek → Osh), in-city delivery, COD for shops.",
    color: "#2E8B57",
    sort: 10,
  },
  {
    slug: "jobutify",
    name: "Jobutify",
    legalName: "ОсОО Жобютифай",
    kind: "service",
    description: "The group's IT company. Builds the ERP, WMS and Kiwi Go apps. Run day-to-day by Edil.",
    color: "#1F4E8C",
    sort: 20,
  },
  {
    slug: "alura-brand",
    name: "Alura Brand",
    kind: "operating",
    description: "The clothing brand. Gives materials and orders to the factory.",
    color: "#9C4F96",
    sort: 30,
  },
  {
    slug: "alura-style",
    name: "Alura Style",
    kind: "operating",
    description: "The garment factory. Two factories tracked separately: ХБК and Ош Район.",
    color: "#B5651D",
    sort: 40,
    units: [
      { slug: "hbk", name: "ХБК", kind: "factory", sort: 10 },
      { slug: "osh-rayon", name: "Ош Район", kind: "factory", sort: 20 },
    ],
  },
  {
    slug: "upsell-group",
    name: "Upsell Group",
    kind: "operating",
    description: "Sales / e-commerce arm (Wildberries and other marketplaces).",
    color: "#875100",
    sort: 50,
  },
  {
    slug: "marketing",
    name: "Marketing",
    kind: "service",
    status: "planned",
    description: "Planned marketing company serving all group companies.",
    color: "#58645D",
    sort: 60,
  },
  {
    slug: "asqa-zou-holding",
    name: "Asqa Zou Holding",
    kind: "holding",
    description: "The holding itself: intercompany contracts, акты and debts.",
    color: "#16201A",
    sort: 70,
  },
];

export interface SeedOptions {
  password?: string;
  /** Override "now" (tests). */
  now?: Date;
  timeZone?: string;
  /** Add "[sample]" projects and tasks (default: no). */
  withSamples?: boolean;
  /**
   * Re-hash the password of founders that already exist and revoke their sessions.
   * Default: existing founders keep their password (re-running the seed is harmless).
   */
  resetPasswords?: boolean;
  /** bcrypt cost; tests use a low value for speed. */
  bcryptRounds?: number;
}

export interface SeedResult {
  userIds: Record<(typeof FOUNDERS)[number]["key"], string>;
  companyIds: Record<string, string>;
  personIds: Record<string, string>;
}

export async function seed(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const password = options.password ?? DEV_PASSWORD_DEFAULT;
  const hash = await bcrypt.hash(password, options.bcryptRounds ?? 10);

  // --- Founders --------------------------------------------------------------
  const userIds = {} as SeedResult["userIds"];
  for (const f of FOUNDERS) {
    const [row] = await db
      .insert(users)
      .values({ email: f.email, name: f.name, shortName: f.shortName, passwordHash: hash, role: "founder" })
      .onConflictDoUpdate({
        target: users.email,
        set: options.resetPasswords
          ? { name: f.name, shortName: f.shortName, passwordHash: hash, updatedAt: new Date() }
          : { name: f.name, shortName: f.shortName },
      })
      .returning({ id: users.id });
    userIds[f.key] = row!.id;
    if (options.resetPasswords) await db.delete(sessions).where(eq(sessions.userId, row!.id));
  }

  // --- Companies & units -----------------------------------------------------
  const companyIds: Record<string, string> = {};
  for (const { units, ...c } of COMPANY_SEED) {
    const [row] = await db
      .insert(companies)
      .values(c)
      .onConflictDoUpdate({
        target: companies.slug,
        set: {
          name: c.name,
          legalName: c.legalName ?? null,
          kind: c.kind,
          status: c.status ?? "active",
          description: c.description,
          color: c.color,
          sort: c.sort,
        },
      })
      .returning({ id: companies.id });
    companyIds[c.slug] = row!.id;
    for (const u of units ?? []) {
      await db
        .insert(companyUnits)
        .values({ ...u, companyId: row!.id })
        .onConflictDoNothing();
    }
  }

  // --- People ----------------------------------------------------------------
  const personIds: Record<string, string> = {};
  async function upsertPerson(
    key: string,
    values: typeof people.$inferInsert,
    links: { company: string; role: string; title?: string }[],
  ) {
    const existing = await db.select({ id: people.id }).from(people).where(eq(people.fullName, values.fullName));
    const id =
      existing[0]?.id ?? (await db.insert(people).values(values).returning({ id: people.id }))[0]!.id;
    personIds[key] = id;
    for (const l of links) {
      await db
        .insert(personCompanies)
        .values({ personId: id, companyId: companyIds[l.company]!, role: l.role, title: l.title })
        .onConflictDoNothing();
    }
  }

  await upsertPerson(
    "nuraaly",
    { fullName: FOUNDERS[0].name, userId: userIds.nuraaly, notes: "Co-founder" },
    COMPANY_SEED.map((c) => ({ company: c.slug!, role: "founder", title: "Co-founder" })),
  );
  await upsertPerson(
    "talant",
    { fullName: FOUNDERS[1].name, userId: userIds.talant, notes: "Co-founder" },
    COMPANY_SEED.map((c) => ({ company: c.slug!, role: "founder", title: "Co-founder" })),
  );
  await upsertPerson("edil", { fullName: "Edil", notes: "Runs Jobutify day-to-day." }, [
    { company: "jobutify", role: "manager", title: "Head of Jobutify" },
  ]);
  await upsertPerson(
    "elmurat",
    { fullName: "Elmurat", notes: "Accountant for several group companies. Owns the monthly акты." },
    [
      { company: "asqa-zou-holding", role: "accountant", title: "Accountant" },
      { company: "alura-style", role: "accountant", title: "Accountant" },
      { company: "alura-brand", role: "accountant", title: "Accountant" },
      { company: "kiwi-go", role: "accountant", title: "Accountant" },
      { company: "jobutify", role: "accountant", title: "Accountant" },
    ],
  );

  // --- Samples ---------------------------------------------------------------
  if (options.withSamples === true) {
    const already = await db.select({ id: tasks.id }).from(tasks).where(like(tasks.title, "[sample]%")).limit(1);
    if (already.length === 0) {
      await seedSamples(db, { userIds, companyIds, personIds }, options);
    }
  }

  return { userIds, companyIds, personIds };
}

async function seedSamples(db: Db, ids: SeedResult, options: SeedOptions) {
  const today = todayInTimeZone(options.now ?? new Date(), options.timeZone);
  const { userIds: u, companyIds: c, personIds: p } = ids;

  const [kiwiApp] = await db
    .insert(projects)
    .values({
      companyId: c["kiwi-go"]!,
      name: "[sample] Kiwi Go courier app v2",
      description: "Sample project. Jobutify builds the new courier app with COD tracking.",
      ownerUserId: u.nuraaly,
      status: "active",
      startDate: addDays(today, -20),
      dueDate: addDays(today, 30),
    })
    .returning({ id: projects.id });
  const [factoryKpi] = await db
    .insert(projects)
    .values({
      companyId: c["alura-style"]!,
      name: "[sample] Daily output report per factory",
      description: "Sample project. Separate numbers for ХБК and Ош Район.",
      ownerUserId: u.talant,
      status: "active",
      startDate: addDays(today, -5),
      dueDate: addDays(today, 14),
    })
    .returning({ id: projects.id });

  await db.insert(tasks).values([
    {
      title: "[sample] Agree COD payout schedule with shops",
      companyId: c["kiwi-go"]!,
      projectId: kiwiApp!.id,
      ownerUserId: u.nuraaly,
      visibility: "shared",
      assigneeUserId: u.nuraaly,
      status: "in_progress",
      priority: "high",
      dueDate: addDays(today, -3), // overdue on purpose
    },
    {
      title: "[sample] Courier app: test release with 3 couriers",
      companyId: c["kiwi-go"]!,
      projectId: kiwiApp!.id,
      ownerUserId: u.nuraaly,
      visibility: "shared",
      assigneePersonId: p.edil,
      status: "todo",
      priority: "normal",
      dueDate: addDays(today, 4),
    },
    {
      title: "[sample] Ask Edil for read-only WMS API access",
      companyId: c["jobutify"]!,
      ownerUserId: u.nuraaly,
      visibility: "shared",
      assigneePersonId: p.edil,
      status: "waiting",
      priority: "normal",
      dueDate: today,
    },
    {
      title: "[sample] Collect ХБК and Ош Район output for last week",
      companyId: c["alura-style"]!,
      projectId: factoryKpi!.id,
      ownerUserId: u.talant,
      visibility: "shared",
      assigneeUserId: u.talant,
      status: "todo",
      priority: "high",
      dueDate: addDays(today, 2),
    },
    {
      title: "[sample] Ask Elmurat for missing October акты",
      companyId: c["asqa-zou-holding"]!,
      ownerUserId: u.talant,
      visibility: "shared",
      assigneePersonId: p.elmurat,
      status: "todo",
      priority: "urgent",
      dueDate: addDays(today, 1),
    },
    {
      title: "[sample] Define Factory KPI card layout",
      companyId: c["alura-style"]!,
      projectId: factoryKpi!.id,
      ownerUserId: u.talant,
      visibility: "shared",
      assigneeUserId: u.talant,
      status: "done",
      priority: "normal",
      dueDate: addDays(today, -1),
      completedAt: new Date(),
    },
    {
      title: "[sample] Nuraaly personal: call the bank about the holding account",
      ownerUserId: u.nuraaly,
      visibility: "private",
      status: "todo",
      priority: "normal",
      dueDate: today,
    },
    {
      title: "[sample] Talant personal: review Wildberries pricing ideas",
      companyId: c["upsell-group"]!,
      ownerUserId: u.talant,
      visibility: "private",
      status: "todo",
      priority: "low",
      dueDate: addDays(today, 3),
    },
  ]);
}
