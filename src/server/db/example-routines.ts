/**
 * Routines on the database side, shared by the services and the seed (no "server-only": the CLI
 * seed uses it): turning validated input into columns, and the founder's first routine —
 * **Elmurat — daily 1C financial entries for all companies** (Mon–Sat, ask 15:00, remind every
 * 2 h until 19:00, tell the founders at 19:00; one checklist item per active company).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { askTimesOf, checklistItems, routineInputSchema, type ChecklistItem } from "@/lib/routines";
import type { Db } from "./connect";
import { appSettings, companies, people, routines } from "./schema";

export const EXAMPLE_ROUTINE_KEY = "elmurat-1c";
const EXAMPLE_MARKER = "example_routines_seeded";

export function routineColumns(p: ReturnType<typeof routineInputSchema.parse>, previous: ChecklistItem[] = []) {
  const chase = Object.fromEntries(Object.entries(p.chase).filter(([, v]) => v !== undefined));
  const times = askTimesOf({ time: p.times[0]!, times: p.times });
  return {
    title: p.title,
    description: p.description,
    companyId: p.companyId,
    assigneePersonId: p.assignee.personId,
    assigneeUserId: p.assignee.userId,
    scheduleKind: p.scheduleKind,
    days: p.scheduleKind === "weekly" ? [...new Set(p.days)].sort((a, b) => a - b) : null,
    monthDay: p.scheduleKind === "monthly" ? (p.monthDay ?? null) : null,
    time: times[0]!,
    times,
    startsOn: p.startsOn ?? null,
    endsOn: p.endsOn ?? null,
    confirmation: p.confirmation,
    items: p.confirmation === "checklist" ? checklistItems(p.items, previous) : [],
    chase: Object.keys(chase).length ? chase : null,
  };
}

/** The example's input, or null when Elmurat is not a person (or no company is active). */
export async function exampleRoutineInput(db: Db): Promise<Record<string, unknown> | null> {
  const [elmurat] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.fullName, "Elmurat"), isNull(people.leftAt), isNull(people.userId)))
    .limit(1);
  if (!elmurat) return null;
  // Every active company (Marketing is "planned", so it joins the list once it starts).
  const live = await db
    .select({ name: companies.name })
    .from(companies)
    .where(and(isNull(companies.archivedAt), eq(companies.status, "active")))
    .orderBy(asc(companies.sort), asc(companies.name));
  if (!live.length) return null;
  return {
    title: "1C: финансовые записи за день",
    description: "Внесите сегодняшние финансовые операции в 1С по каждой компании и отметьте её.",
    companyId: null,
    assignee: `person:${elmurat.id}`,
    scheduleKind: "weekly",
    days: [1, 2, 3, 4, 5, 6],
    time: "15:00",
    confirmation: "checklist",
    items: live.map((c) => c.name),
    chase: { chaseEveryMinutes: 120, chaseUntil: "19:00", escalateAt: "19:00" },
  };
}

/**
 * Seed / deploy: creates the example ONCE — only if Elmurat exists as a person, only if absent,
 * and never again after a founder deleted it (a marker in app_settings). Returns true if created.
 */
export async function ensureExampleRoutine(db: Db, now: Date): Promise<boolean> {
  const [marker] = await db.select().from(appSettings).where(eq(appSettings.key, EXAMPLE_MARKER));
  if (marker) return false;
  const [existing] = await db.select({ id: routines.id }).from(routines).where(eq(routines.seedKey, EXAMPLE_ROUTINE_KEY));
  const input = existing ? null : await exampleRoutineInput(db);
  if (!existing && !input) return false; // Elmurat not there (yet): a later seed tries again.
  let created = false;
  if (input) {
    const rows = await db
      .insert(routines)
      .values({ ...routineColumns(routineInputSchema.parse(input)), status: "active", seedKey: EXAMPLE_ROUTINE_KEY, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: routines.seedKey })
      .returning({ id: routines.id });
    created = rows.length > 0;
  }
  await db.insert(appSettings).values({ key: EXAMPLE_MARKER, value: { [EXAMPLE_ROUTINE_KEY]: now.toISOString() } }).onConflictDoNothing();
  return created;
}
