/**
 * The Tasks page's URL (0034) → list filters and display options. Pure (unit-tested): bad values
 * are dropped, so a hand-edited or old link never errors. Old links keep working: `view=mine|my|
 * assigned` → the "Me" person chip, `view=company` → everything, `view=overdue` / `status=overdue`
 * → the Due filter, `status=done|any|open`, `who=…`, `company=…`, `from` / `to`, `quick`, `sort`.
 */
import { isIsoDate } from "./dates";
import { TASK_DUE_FILTERS, TASK_ESTIMATE_VALUES, TASK_PRIORITY_VALUES, TASK_QUICK_FILTERS, TASK_STATUS_VALUES, type TaskFilters } from "./schemas";

export const LIST_VIEWS = ["active", "backlog", "all"] as const;
export type ListView = (typeof LIST_VIEWS)[number];
export const TASK_GROUPINGS = ["status", "assignee", "priority", "company", "project", "none"] as const;
export const TASK_ORDERINGS = ["priority", "due", "updated", "created"] as const;
export const TASK_PROPERTIES = ["key", "priority", "labels", "company", "project", "due", "estimate", "assignee", "created", "updated", "activity"] as const;
export const DEFAULT_HIDDEN_PROPERTIES = ["updated"] as const;

export const VIEW_STATUSES: Record<ListView, readonly string[]> = {
  active: ["in_review", "in_progress", "todo"],
  backlog: ["backlog"],
  all: ["in_review", "in_progress", "todo", "backlog", "done", "cancelled"],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^(user|person):([0-9a-f-]{36})$/i;

export interface TaskListParams {
  view: ListView;
  /** "me", "user:<id>", "person:<id>", "unassigned" or "". */
  who: string;
  filters: TaskFilters;
  /** Statuses the status groups show (also when empty). */
  statusScope: readonly string[];
  group: (typeof TASK_GROUPINGS)[number];
  order: (typeof TASK_ORDERINGS)[number];
  hidden: string[];
  /** The params as they are understood (the toolbar's links). */
  query: Record<string, string>;
  /** A filtered single company (preset of "+" in a group). */
  companyId: string | null;
}

type SP = Record<string, string | string[] | undefined>;

export function parseTaskListParams(sp: SP): TaskListParams {
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const list = (k: string) => str(k).split(",").map((s) => s.trim()).filter(Boolean);
  const query: Record<string, string> = {};
  const put = (k: string, v: string | string[]) => {
    const s = Array.isArray(v) ? v.join(",") : v;
    if (s) query[k] = s;
  };

  // View (+ old views and old status tabs).
  let viewRaw = str("view");
  let who = str("who");
  const due = new Set(list("due").filter((d) => (TASK_DUE_FILTERS as readonly string[]).includes(d)));
  let statuses = list("status").map((s) => (s === "waiting" ? "in_review" : s === "canceled" ? "cancelled" : s));
  if (["mine", "my", "assigned"].includes(viewRaw)) {
    who = who || "me";
    viewRaw = "";
  } else if (viewRaw === "company") viewRaw = "";
  else if (viewRaw === "overdue") {
    due.add("overdue");
    viewRaw = "";
  }
  if (statuses.includes("overdue")) {
    due.add("overdue");
    statuses = statuses.filter((s) => s !== "overdue");
  }
  if (statuses.includes("any")) {
    viewRaw = "all";
    statuses = statuses.filter((s) => s !== "any");
  }
  if (statuses.includes("open")) {
    viewRaw = viewRaw || "all";
    statuses = [...statuses.filter((s) => s !== "open"), "backlog", "todo", "in_progress", "in_review"];
  }
  statuses = [...new Set(statuses.filter((s) => (TASK_STATUS_VALUES as readonly string[]).includes(s)))];
  const view: ListView = (LIST_VIEWS as readonly string[]).includes(viewRaw) ? (viewRaw as ListView) : "active";
  if (view !== "active") put("view", view);

  if (!(who === "me" || who === "unassigned" || (REF.test(who) && UUID.test(who.split(":")[1]!)))) who = "";
  put("who", who);

  const priorities = list("priority").map((p) => (p === "normal" ? "medium" : p)).filter((p) => (TASK_PRIORITY_VALUES as readonly string[]).includes(p));
  const assignees = list("assignee").filter((a) => a === "unassigned" || (REF.test(a) && UUID.test(a.split(":")[1]!)));
  const companyIds = list("company").filter((c) => UUID.test(c));
  const projectIds = list("project").filter((c) => UUID.test(c));
  const labelIds = list("label").filter((c) => UUID.test(c));
  const estimates = list("estimate").filter((e) => e === "0" || (TASK_ESTIMATE_VALUES as readonly number[]).includes(Number(e)));
  const over = str("over") === "1";
  const search = str("search").slice(0, 200);
  const quick = [...new Set(list("quick").filter((q) => (TASK_QUICK_FILTERS as readonly string[]).includes(q)))];
  const from = isIsoDate(str("from")) ? str("from") : null;
  const to = isIsoDate(str("to")) ? str("to") : null;
  put("status", statuses);
  put("priority", priorities);
  put("assignee", assignees);
  put("company", companyIds);
  put("project", projectIds);
  put("label", labelIds);
  put("due", [...due]);
  put("estimate", estimates);
  if (over) put("over", "1");
  put("search", search);
  put("quick", quick);
  if (from) put("from", from);
  if (to) put("to", to);

  // Display.
  const legacySort: Record<string, string> = { newest: "created", due: "due", title: "updated" };
  const groupRaw = str("group");
  const orderRaw = str("order") || legacySort[str("sort")] || "";
  const group = (TASK_GROUPINGS as readonly string[]).includes(groupRaw) ? (groupRaw as TaskListParams["group"]) : "status";
  const order = (TASK_ORDERINGS as readonly string[]).includes(orderRaw) ? (orderRaw as TaskListParams["order"]) : "priority";
  if (group !== "status") put("group", group);
  if (order !== "priority") put("order", order);
  const hideRaw = str("hide");
  const hidden = hideRaw === "none" ? [] : hideRaw ? list("hide").filter((h) => (TASK_PROPERTIES as readonly string[]).includes(h)) : [...DEFAULT_HIDDEN_PROPERTIES];
  if (hideRaw) put("hide", hideRaw === "none" ? "none" : hidden.join(","));

  // Filters for the service.
  const filters: TaskFilters = {
    status: statuses.length ? undefined : view === "all" ? "any" : view === "backlog" ? "backlog" : "active",
    statuses: statuses.length ? (statuses as TaskFilters["statuses"]) : undefined,
    priorities: priorities.length ? (priorities as TaskFilters["priorities"]) : undefined,
    assignees: assignees.length ? assignees : undefined,
    companyIds: companyIds.length ? companyIds : undefined,
    projectIds: projectIds.length ? projectIds : undefined,
    labelIds: labelIds.length ? labelIds : undefined,
    estimates: estimates.length ? estimates.map(Number) : undefined,
    due: due.size ? ([...due] as TaskFilters["due"]) : undefined,
    overEstimate: over || undefined,
    search: search || undefined,
    quick: quick.length ? (quick as TaskFilters["quick"]) : undefined,
    dueFrom: from,
    dueTo: to,
    limit: 500,
  };
  if (who === "me") filters.view = "mine";
  else if (who) filters.assignees = [...((filters.assignees as string[] | undefined) ?? []), who];
  // Legacy: who + assignee filter both given → both apply (AND) only when they differ; keep simple: who wins.
  if (who && who !== "me" && assignees.length) filters.assignees = [who];

  return {
    view,
    who,
    filters,
    statusScope: statuses.length ? statuses : VIEW_STATUSES[view],
    group,
    order,
    hidden,
    query,
    companyId: companyIds.length === 1 ? companyIds[0]! : null,
  };
}
