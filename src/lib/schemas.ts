/**
 * Zod input schemas shared by server actions and the REST API.
 * Form posts send "" for empty fields; `blankToNull` turns those into null.
 */
import { z } from "zod";
import { isIsoDate, isTimeInWindow } from "./dates";

export const TASK_STATUS_VALUES = ["todo", "in_progress", "waiting", "done", "cancelled"] as const;
export const TASK_PRIORITY_VALUES = ["urgent", "high", "normal", "low"] as const;
export const TASK_VISIBILITY_VALUES = ["private", "shared"] as const;
export const PROJECT_STATUS_VALUES = ["planned", "active", "on_hold", "done", "cancelled"] as const;
/**
 * Task views. "mine" (the Tasks page's "My tasks") = my personal todos + tasks assigned to me +
 * shared tasks I created with no assignee. "my" (personal todos only), "assigned" and "overdue"
 * stay for the REST API / assistant and old links (the page redirects them to "mine").
 */
export const TASK_VIEWS = ["mine", "my", "assigned", "company", "overdue"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

/** Quick filters of the task list (toggle chips; several combine with AND). */
export const TASK_QUICK_FILTERS = ["personal", "assigned", "overdue", "week", "waiting", "comments"] as const;
export type TaskQuickFilter = (typeof TASK_QUICK_FILTERS)[number];
export const TASK_SORTS = ["due", "newest", "title"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const optionalUuid = z.preprocess(blankToNull, z.uuid().nullable().optional());
const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
export const isoDateSchema = z
  .string()
  .refine(isIsoDate, { message: "Use a valid date (YYYY-MM-DD)" });
const optionalDate = z.preprocess(blankToNull, isoDateSchema.nullable().optional());

const taskFields = {
  title: z.string().trim().min(1, "Title is required").max(300),
  notes: optionalText(5000),
  companyId: optionalUuid,
  projectId: optionalUuid,
  visibility: z.enum(TASK_VISIBILITY_VALUES),
  assigneeUserId: optionalUuid,
  assigneePersonId: optionalUuid,
  /** Optional department of the company's org chart (must be of the task's company). */
  orgDepartmentId: optionalUuid,
  status: z.enum(TASK_STATUS_VALUES),
  priority: z.enum(TASK_PRIORITY_VALUES),
  dueDate: optionalDate,
};

export const taskCreateSchema = z
  .object({
    ...taskFields,
    visibility: taskFields.visibility.default("shared"),
    status: taskFields.status.default("todo"),
    priority: taskFields.priority.default("normal"),
  })
  .strict();
export type TaskCreateInput = z.input<typeof taskCreateSchema>;

export const taskUpdateSchema = z
  .object(taskFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export type TaskUpdateInput = z.input<typeof taskUpdateSchema>;

export const taskFiltersSchema = z.object({
  view: z.preprocess(blankToNull, z.enum(TASK_VIEWS).nullable().optional()),
  companyId: optionalUuid,
  projectId: optionalUuid,
  /** Only tasks assigned to this founder / person (exact assignee, not "relevant to"). */
  assigneeUserId: optionalUuid,
  assigneePersonId: optionalUuid,
  /** A status, "open" (not done / cancelled), "overdue" (open and past due) or "any". */
  status: z.preprocess(
    blankToNull,
    z.enum([...TASK_STATUS_VALUES, "open", "overdue", "any"]).nullable().optional(),
  ),
  priority: z.preprocess(blankToNull, z.enum(TASK_PRIORITY_VALUES).nullable().optional()),
  /** Title only (REST API). */
  q: optionalText(200),
  /** Title, assignee or company name (the list's search box). */
  search: optionalText(200),
  quick: z.array(z.enum(TASK_QUICK_FILTERS)).max(TASK_QUICK_FILTERS.length).optional(),
  /** Due date range (inclusive). */
  dueFrom: optionalDate,
  dueTo: optionalDate,
  sort: z.preprocess(blankToNull, z.enum(TASK_SORTS).nullable().optional()),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type TaskFilters = z.input<typeof taskFiltersSchema>;

export const projectCreateSchema = z
  .object({
    companyId: z.uuid(),
    name: z.string().trim().min(1, "Name is required").max(200),
    description: optionalText(5000),
    status: z.enum(PROJECT_STATUS_VALUES).default("active"),
    startDate: optionalDate,
    dueDate: optionalDate,
  })
  .strict();
export type ProjectCreateInput = z.input<typeof projectCreateSchema>;

/** UI assignee picker encodes "user:<uuid>" / "person:<uuid>" / "". */
export function parseAssignee(value: unknown): {
  assigneeUserId: string | null;
  assigneePersonId: string | null;
} {
  if (typeof value !== "string" || value === "") return { assigneeUserId: null, assigneePersonId: null };
  const [kind, id] = value.split(":");
  if (kind === "user" && id) return { assigneeUserId: id, assigneePersonId: null };
  if (kind === "person" && id) return { assigneeUserId: null, assigneePersonId: id };
  return { assigneeUserId: null, assigneePersonId: null };
}

// ---------------------------------------------------------------------------
// Notification preferences (Settings page)
// ---------------------------------------------------------------------------
const hmTime = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Use HH:MM (24h)");
/** Checkboxes post "on" or nothing. */
const formBool = z.preprocess((v) => v === true || v === "on" || v === "true" || v === "1", z.boolean());

/**
 * How overdue tasks are chased on chase days (Settings → Notifications):
 * - "separate": one push per overdue task (within the daily budget);
 * - "grouped": one 10:00 push listing every task due a chase that day, with buttons per task —
 *   the default (the founders chose it for both of them; migration 0016);
 * - "summary_only": no chase pushes; overdue tasks are listed only in the morning summary.
 */
export const OVERDUE_CHASE_STYLES = ["separate", "grouped", "summary_only"] as const;
export type OverdueChaseStyle = (typeof OVERDUE_CHASE_STYLES)[number];
export const DEFAULT_OVERDUE_CHASE_STYLE: OverdueChaseStyle = "grouped";

export const notificationPrefsSchema = z
  .object({
    morningSummaryTime: hmTime,
    eveningCheckEnabled: formBool,
    eveningCheckTime: hmTime,
    quietStart: hmTime,
    quietEnd: hmTime,
    maxOtherPerDay: z.coerce.number().int().min(0, "0 or more").max(10, "At most 10"),
    urgentAtNight: formBool,
    /** Optional: leaving it out keeps the saved style (new founders get "grouped"). */
    overdueChaseStyle: z.enum(OVERDUE_CHASE_STYLES, { message: "Pick how overdue tasks are chased" }).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    // The evening check expires at midnight, so inside quiet hours it is held and then
    // dropped unseen (22:00 with quiet hours 21:00-08:00 would never arrive). Rejected.
    const quiet = `${p.quietStart}–${p.quietEnd}`;
    if (p.eveningCheckEnabled && isTimeInWindow(p.eveningCheckTime, p.quietStart, p.quietEnd)) {
      ctx.addIssue({
        code: "custom",
        path: ["eveningCheckTime"],
        message: `The evening check is inside your quiet hours (${quiet}) so it would arrive late or not at all. Pick a time outside them or change the quiet hours.`,
      });
    }
  });
export type NotificationPrefsInput = z.input<typeof notificationPrefsSchema>;
