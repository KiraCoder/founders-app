import "server-only";
import { z } from "zod";
import { describeSchedule, type RoutineInput } from "@/lib/routines";
import type { ServiceContext } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { routineFormOptions, type RoutineView } from "@/server/services/routines";
import type { PreviewField } from "@/server/mcp/registry";
import { pickOne, resolveCompany, nameKeys } from "@/server/mcp/resolve";

/**
 * THE one place that maps the assistant's routine tool arguments onto the CURRENT routines
 * service input (`routineInputSchema` in src/lib/routines.ts: one weekly/monthly schedule, one
 * time, button/checklist confirmation, chase override). When the routines service gains new
 * fields (several times a day, an end date, ...), update `routineArgs`, `toRoutineInput`,
 * `currentArgs` and `routinePreview` here; the tools (routine-tools.ts) need no change.
 */

const hm = z.string().regex(/^\d{1,2}:\d{2}$/, "HH:MM");

const DAY_WORDS: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 7,
};

/** 1–7 (Mon=1) or a day name ("mon", "Monday", "пн"). */
const day = z.preprocess((v) => {
  if (typeof v === "number") return v;
  const s = String(v).trim().toLowerCase();
  if (/^\d$/.test(s)) return Number(s);
  return DAY_WORDS[s.slice(0, s.match(/^[a-z]/) ? 3 : 2)] ?? v;
}, z.number().int().min(1).max(7));

/** Arguments of create_routine / update_routine (short names and docs: fewer tokens). */
export const routineArgs = {
  title: z.string().trim().min(1).max(200).describe("Short name"),
  who: z.string().max(200).describe("Assignee: founder name, 'me', or a person"),
  company: z.string().max(200).nullable().optional().describe("Company name, or null"),
  schedule: z.enum(["weekly", "monthly"]).optional().describe("Default weekly"),
  days: z.array(day).max(7).optional().describe("Weekly: 1=Mon … 7=Sun"),
  month_day: z.number().int().min(1).max(31).optional().describe("Monthly: day 1–31"),
  time: hm.describe("Ask time HH:MM (Bishkek)"),
  checklist: z.array(z.string().trim().min(1).max(60)).max(20).optional().describe("Items to tick; empty = one Done button"),
  description: z.string().max(2000).optional(),
  chase_every: z.number().int().min(15).max(1440).optional().describe("Reminder every N min"),
  chase_until: hm.optional().describe("No reminders after HH:MM"),
  escalate_at: hm.nullable().optional().describe("Tell founders at HH:MM if not done; null = off"),
};

const routineArgsObject = z.object(routineArgs);
export type RoutineArgs = z.infer<typeof routineArgsObject>;
export const routineUpdateArgs = routineArgsObject.partial().shape;
export type RoutineUpdateArgs = Partial<RoutineArgs>;

const pad = (t: string) => (t.length === 4 ? `0${t}` : t);

export interface ResolvedRoutine {
  input: RoutineInput;
  who: string;
  companyName: string | null;
}

/** Founders + people still here (the routine form's choices), fuzzy-matched by name. */
async function resolveRoutineAssignee(ctx: ServiceContext, ref: string): Promise<{ ref: string; name: string }> {
  const opts = await routineFormOptions(ctx);
  const me = ["me", "i", "myself", "я", "мне", "мен"].includes(ref.trim().toLowerCase());
  if (me) return { ref: `user:${ctx.user.id}`, name: ctx.user.shortName };
  return pickOne(
    ref,
    [
      ...opts.founders.map((f) => ({ value: { ref: `user:${f.id}`, name: f.name }, label: `${f.name} (founder)`, keys: [f.id, ...nameKeys(f.name)] })),
      ...opts.people.map((p) => ({ value: { ref: `person:${p.id}`, name: p.name }, label: p.name, keys: [p.id, ...nameKeys(p.name)] })),
    ],
    "person",
  );
}

/** Tool args (merged over the current routine for an update) → the routines service input. */
export async function toRoutineInput(ctx: ServiceContext, a: RoutineArgs): Promise<ResolvedRoutine> {
  const who = await resolveRoutineAssignee(ctx, a.who);
  const company = a.company ? await resolveCompany(ctx, a.company) : null;
  const kind = a.schedule ?? (a.month_day && !a.days?.length ? "monthly" : "weekly");
  if (kind === "weekly" && !a.days?.length) throw new ServiceError("validation", "Which days? (1=Mon … 7=Sun)");
  if (kind === "monthly" && !a.month_day) throw new ServiceError("validation", "Which day of the month?");
  const items = a.checklist ?? [];
  const chase: Record<string, unknown> = {};
  if (a.chase_every !== undefined) chase.chaseEveryMinutes = a.chase_every;
  if (a.chase_until !== undefined) chase.chaseUntil = pad(a.chase_until);
  if (a.escalate_at !== undefined) chase.escalateAt = a.escalate_at === null ? null : pad(a.escalate_at);
  return {
    who: who.name,
    companyName: company?.name ?? null,
    input: {
      title: a.title,
      description: a.description ?? "",
      companyId: company?.id ?? null,
      assignee: who.ref,
      scheduleKind: kind,
      days: kind === "weekly" ? [...new Set(a.days)].sort() : [],
      monthDay: kind === "monthly" ? a.month_day : undefined,
      time: pad(a.time),
      confirmation: items.length ? "checklist" : "button",
      items,
      chase: chase as RoutineInput["chase"],
    },
  };
}

/** The current routine as tool args (the base an update is merged onto). */
export function currentArgs(v: RoutineView): RoutineArgs {
  const r = v.routine;
  const o = v.override;
  return {
    title: r.title,
    who: r.assigneePersonId ? r.assigneePersonId : (r.assigneeUserId ?? ""),
    company: v.companyName,
    schedule: r.scheduleKind === "monthly" ? "monthly" : "weekly",
    days: r.days ?? [],
    month_day: r.monthDay ?? undefined,
    time: r.time,
    checklist: r.confirmation === "checklist" ? r.items.map((i) => i.label) : [],
    description: r.description,
    chase_every: o.chaseEveryMinutes,
    chase_until: o.chaseUntil,
    escalate_at: o.escalateAt,
  };
}

/** Card lines: who, company, days, time, checklist, chase. */
export function routinePreview(r: ResolvedRoutine): PreviewField[] {
  const i = r.input;
  const schedule =
    i.scheduleKind === "monthly"
      ? describeSchedule({ kind: "monthly", monthDay: Number(i.monthDay ?? 1), time: i.time })
      : describeSchedule({ kind: "weekly", days: (i.days as number[]) ?? [], time: i.time });
  const c = (i.chase ?? {}) as Record<string, unknown>;
  const chase = [
    c.chaseEveryMinutes ? `every ${c.chaseEveryMinutes} min` : null,
    c.chaseUntil ? `until ${c.chaseUntil}` : null,
    c.escalateAt === null ? "no escalation" : c.escalateAt ? `escalate at ${c.escalateAt}` : null,
  ].filter(Boolean);
  const items = (i.items as string[]) ?? [];
  return [
    { label: "Routine", value: i.title },
    { label: "Who", value: r.who },
    { label: "Company", value: r.companyName ?? "—" },
    { label: "Days", value: schedule.replace(/,?\s\d{2}:\d{2}$/, "") || schedule },
    { label: "Time", value: i.time },
    { label: "Checklist", value: items.length ? items.map((x) => `☐ ${x}`).join("\n") : "One “Done” button" },
    { label: "Chase", value: chase.length ? chase.join(", ") : "Default reminders" },
  ];
}
