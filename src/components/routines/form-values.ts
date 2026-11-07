/** Routine form values and options (shared by the server pages and the client form; not a client module). */
import type { ChecklistDraftItem } from "@/components/ui/ChecklistEditor";
import type { ReminderMode, RoutineChase, RoutineChaseOverride } from "@/lib/routines";
import type { RoutineView } from "@/server/services/routines";

export type EscalationMode = "off" | "at" | "after";

export interface RoutineFormValues {
  id?: string;
  title: string;
  description: string;
  companyId: string;
  assignee: string;
  scheduleKind: "weekly" | "monthly";
  days: number[];
  monthDay: string;
  /** Ask times, e.g. ["10:00", "16:00"]. */
  times: string[];
  startsOn: string;
  endsOn: string;
  confirmation: "button" | "checklist";
  items: ChecklistDraftItem[];
  /** The routine's own chase override (blank fields = the defaults). */
  chase: RoutineChaseOverride;
}

/** Today's run as the edit form needs it (to explain what an edit of the checklist does). */
export interface RoutineTodayRun {
  status: string;
  /** Item keys on today's run. */
  itemKeys: string[];
}

export interface RoutineFormOptions {
  founders: { id: string; name: string }[];
  /** People who can be assigned, with the companies they work for (empty = any company). */
  people: { id: string; name: string; companyIds: string[]; defaults: RoutineChase }[];
  companies: { id: string; name: string }[];
  /** What a blank chase field means (the global staff defaults; a person's own are on `people`). */
  defaults: RoutineChase;
  /** What a blank chase field means for a founder's routine (the ask + one reminder). */
  founderDefaults: RoutineChase;
}

export const EMPTY_ROUTINE: RoutineFormValues = {
  title: "",
  description: "",
  companyId: "",
  assignee: "",
  scheduleKind: "weekly",
  days: [1, 2, 3, 4, 5],
  monthDay: "",
  times: ["10:00"],
  startsOn: "",
  endsOn: "",
  confirmation: "button",
  items: [],
  chase: {},
};

/** The edit form's values for an existing routine. */
export function routineFormValues(view: RoutineView): RoutineFormValues {
  const r = view.routine;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    companyId: r.companyId ?? "",
    assignee: r.assigneePersonId ? `person:${r.assigneePersonId}` : `user:${r.assigneeUserId}`,
    scheduleKind: r.scheduleKind === "monthly" ? "monthly" : "weekly",
    days: r.days ?? [],
    monthDay: r.monthDay ? String(r.monthDay) : "",
    times: view.times,
    startsOn: r.startsOn ?? "",
    endsOn: r.endsOn ?? "",
    confirmation: r.confirmation === "checklist" ? "checklist" : "button",
    items: r.items.map((i) => ({ key: i.key, label: i.label, details: i.details ?? "", needsComment: !!i.needsComment })),
    chase: view.override,
  };
}

export function todayRunOf(view: RoutineView): RoutineTodayRun | null {
  return view.today ? { status: view.today.status, itemKeys: view.today.items.map((i) => i.key) } : null;
}

export const REMINDER_MODE_LABELS: Record<ReminderMode, string> = {
  once: "Ask once",
  every: "Remind every … until …",
  times: "Remind N times",
};
