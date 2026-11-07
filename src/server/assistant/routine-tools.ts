import "server-only";
import { z } from "zod";
import { todayInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/services/context";
import { createRoutine, getRoutine, listRoutineRuns, listRoutines, setRoutineStatus, updateRoutine, type RoutineView } from "@/server/services/routines";
import { readTool, writeTool, type ActionPreview, type AnyTool } from "@/server/mcp/registry";
import { normalizeName, pickOne, resolveCompany, nameKeys } from "@/server/mcp/resolve";
import { currentArgs, routineArgs, routinePreview, routineUpdateArgs, toRoutineInput, type RoutineArgs } from "./routine-adapter";
import type { RoutineInput } from "@/lib/routines";
import { ServiceError } from "@/server/services/errors";

/**
 * Routine tools (assistant surface): read routines with today's run, recent runs, and create /
 * change routines through the routines service. Argument mapping lives in routine-adapter.ts.
 */

function todayOut(v: RoutineView, ctx: ServiceContext) {
  const run = v.today;
  if (!run) return v.routine.status === "active" ? "not scheduled or not asked yet today" : null;
  const done = new Set(run.itemsDone);
  const missing = run.items.filter((i) => !done.has(i.key)).map((i) => i.label);
  return {
    status: run.status,
    ...(run.items.length ? { ticked: `${run.items.length - missing.length}/${run.items.length}` } : {}),
    ...(missing.length && run.status !== "done" ? { missing } : {}),
    ...(run.doneAt ? { done_at: run.doneAt.toLocaleTimeString("en-GB", { timeZone: ctx.timeZone, hour: "2-digit", minute: "2-digit" }) } : {}),
  };
}

function routineOut(v: RoutineView, ctx: ServiceContext, full = false) {
  const r = v.routine;
  return {
    id: r.id,
    title: r.title,
    who: `${v.assigneeName}${v.assigneeKind === "founder" ? " (founder)" : ""}`,
    company: v.companyName,
    when: v.scheduleText,
    status: r.status,
    ...(r.confirmation === "checklist" ? { checklist: full ? r.items.map((i) => i.label) : r.items.length } : {}),
    ...(v.assigneeKind === "person" && !v.reachable ? { warning: "not on Telegram" } : {}),
    today: todayOut(v, ctx),
    ...(full ? { description: r.description || undefined, chase: v.chase } : {}),
  };
}

async function findRoutine(ctx: ServiceContext, ref: string): Promise<RoutineView> {
  const rows = await listRoutines(ctx, { status: "all" });
  const v = pickOne(
    ref,
    rows.map((x) => ({ value: x, label: `${x.routine.title} (${x.assigneeName})`, keys: [x.routine.id, normalizeName(x.routine.title)] })),
    "routine",
  );
  return getRoutine(ctx, v.routine.id);
}

const listRoutinesTool = readTool({
  name: "list_routines",
  title: "List routines",
  description: "Recurring routines with today's run (done? which checklist items are missing).",
  brief: "Recurring routines with today's run (status, ticked, missing items).",
  input: {
    who: z.string().max(200).optional().describe("Assignee name"),
    company: z.string().max(200).optional(),
    status: z.enum(["active", "paused", "archived", "all"]).optional().describe("Default active"),
  },
  surfaces: ["assistant"],
  group: "routines",
  async run({ ctx }, a) {
    const c = a.company ? await resolveCompany(ctx, a.company) : null;
    let rows = await listRoutines(ctx, { companyId: c?.id, status: a.status ?? "active" });
    if (a.who) {
      const names = [...new Map(rows.map((r) => [r.assigneeName, r])).keys()];
      const name = pickOne(a.who, names.map((n) => ({ value: n, label: n, keys: nameKeys(n) })), "assignee", " among routines");
      rows = rows.filter((r) => r.assigneeName === name);
    }
    return { summary: `${rows.length} routines (today ${todayInTimeZone(ctx.now, ctx.timeZone)}).`, data: rows.map((v) => routineOut(v, ctx)) };
  },
});

const getRoutineTool = readTool({
  name: "get_routine",
  title: "Get a routine",
  description: "One routine: settings, checklist and the last runs (outcome, missing items).",
  brief: "One routine with checklist and its last runs.",
  input: { routine: z.string().min(1).max(200).describe("Routine id or title"), runs: z.number().int().min(1).max(30).optional().describe("Last N runs (default 7)") },
  surfaces: ["assistant"],
  group: "routines",
  async run({ ctx }, a) {
    const v = await findRoutine(ctx, a.routine);
    const runs = await listRoutineRuns(ctx, v.routine.id, a.runs ?? 7);
    return {
      summary: `Routine “${v.routine.title}”.`,
      data: {
        ...routineOut(v, ctx, true),
        runs: runs.map((r) => ({ date: r.run.runDate.slice(5), outcome: r.outcome, ...(r.missing.length ? { missing: r.missing } : {}) })),
      },
    };
  },
});

interface CreateRoutinePlan {
  input: RoutineInput;
}

const createRoutineTool = writeTool({
  name: "create_routine",
  title: "Create a routine",
  description: "Creates a recurring routine (the Cockpit asks and chases the assignee).",
  brief: "Create a recurring routine for a person or founder.",
  input: routineArgs,
  surfaces: ["assistant"],
  group: "routines",
  async prepare({ ctx }, a): Promise<{ plan: CreateRoutinePlan; preview: ActionPreview }> {
    const r = await toRoutineInput(ctx, a as RoutineArgs);
    return { plan: { input: r.input }, preview: { title: "New routine", confirm: "Create", fields: routinePreview(r) } };
  },
  async commit({ ctx, baseUrl }, plan: CreateRoutinePlan) {
    const row = await createRoutine(ctx, plan.input);
    return { summary: `Created routine “${row.title}”: ${baseUrl}/routines/${row.id}`, data: { id: row.id } };
  },
});

interface UpdateRoutinePlan {
  id: string;
  input: RoutineInput | null;
  status: "active" | "paused" | null;
}

const updateRoutineTool = writeTool({
  name: "update_routine",
  title: "Change a routine",
  description: "Changes a routine (only the fields given) or pauses / resumes it.",
  brief: "Change a routine (only fields given) or pause/resume it.",
  input: {
    routine: z.string().min(1).max(200).describe("Routine id or title"),
    ...routineUpdateArgs,
    state: z.enum(["active", "paused"]).optional().describe("Pause or resume"),
  },
  surfaces: ["assistant"],
  group: "routines",
  async prepare({ ctx }, { routine, state, ...changes }): Promise<{ plan: UpdateRoutinePlan; preview: ActionPreview }> {
    const v = await findRoutine(ctx, routine);
    const given = Object.fromEntries(Object.entries(changes).filter(([, x]) => x !== undefined)) as Partial<RoutineArgs>;
    if (!Object.keys(given).length && !state) throw new ServiceError("validation", "Nothing to change");
    const base = currentArgs(v);
    if (given.month_day && !given.days) base.days = [];
    if (given.days && !given.month_day) base.month_day = undefined;
    const r = Object.keys(given).length ? await toRoutineInput(ctx, { ...base, ...given }) : null;
    const fields = r ? routinePreview(r) : [{ label: "Routine", value: v.routine.title }];
    if (state) fields.push({ label: "State", value: `${v.routine.status} → ${state}` });
    return { plan: { id: v.routine.id, input: r?.input ?? null, status: state ?? null }, preview: { title: "Change routine", confirm: "Save changes", fields } };
  },
  async commit({ ctx, baseUrl }, plan: UpdateRoutinePlan) {
    let title = "";
    if (plan.input) title = (await updateRoutine(ctx, plan.id, plan.input)).title;
    if (plan.status) title = (await setRoutineStatus(ctx, plan.id, plan.status)).title;
    return { summary: `Updated routine “${title}”: ${baseUrl}/routines/${plan.id}`, data: { id: plan.id } };
  },
});

export const ROUTINE_TOOLS: readonly AnyTool[] = [listRoutinesTool, getRoutineTool, createRoutineTool, updateRoutineTool];
