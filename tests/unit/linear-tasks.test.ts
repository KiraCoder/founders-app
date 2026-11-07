/** Pure parts of the Linear-style tasks (0034): working hours, keys, Markdown, the list URL, grouping. */
import { describe, expect, it, vi } from "vitest";
import { isOverEstimate, workingMinutesBetween } from "@/lib/work-hours";
import { parseTaskKey, prefixFromSlug, taskKey } from "@/lib/task-keys";
import { checkboxProgress, parseMarkdown, toggleCheckbox } from "@/lib/markdown";
import { parseTaskListParams } from "@/lib/task-list-params";
import { nextStartedAt, personStatusText } from "@/server/services/tasks-rules";
import type { TaskItem } from "@/components/tasks/types";

vi.mock("@/app/(app)/tasks/actions", () => ({}));
const { groupTasks } = await import("@/components/tasks/TaskBoard");

const local = (day: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 6, m!));
};
const W = { workStart: "09:00", workEnd: "18:00", timeZone: "Asia/Bishkek" };

describe("working hours (1 point = 1 working hour)", () => {
  it("counts only the work window, Monday to Saturday", () => {
    expect(workingMinutesBetween(local("2026-11-02", "08:00"), local("2026-11-02", "10:00"), W)).toBe(60);
    expect(workingMinutesBetween(local("2026-11-02", "17:00"), local("2026-11-03", "10:00"), W)).toBe(120);
    // Saturday 17:00 → Monday 10:00: 1 h on Saturday, nothing on Sunday, 1 h on Monday.
    expect(workingMinutesBetween(local("2026-11-07", "17:00"), local("2026-11-09", "10:00"), W)).toBe(120);
    expect(workingMinutesBetween(local("2026-11-03", "10:00"), local("2026-11-02", "10:00"), W)).toBe(0);
  });
  it("over estimate only while In Progress with an estimate", () => {
    const t = { status: "in_progress", estimate: 2, startedAt: local("2026-11-02", "09:00") };
    expect(isOverEstimate(t, local("2026-11-02", "11:00"), W)).toBe(false);
    expect(isOverEstimate(t, local("2026-11-02", "11:01"), W)).toBe(true);
    expect(isOverEstimate({ ...t, status: "in_review" }, local("2026-11-05", "12:00"), W)).toBe(false);
    expect(isOverEstimate({ ...t, estimate: null }, local("2026-11-05", "12:00"), W)).toBe(false);
  });
  it("started_at follows In Progress", () => {
    const now = new Date("2026-11-02T06:00:00Z");
    const before = new Date("2026-11-01T06:00:00Z");
    expect(nextStartedAt({ status: "todo", startedAt: null }, "in_progress", now)).toBe(now);
    expect(nextStartedAt({ status: "in_progress", startedAt: before }, "in_progress", now)).toBe(before);
    expect(nextStartedAt({ status: "in_progress", startedAt: before }, "in_review", now)).toBe(before);
    expect(nextStartedAt({ status: "in_progress", startedAt: before }, "todo", now)).toBeNull();
    expect(personStatusText("in_review")).toBe("Sent for review");
  });
});

describe("task keys", () => {
  it("prefix from the slug, clashes resolved like the migration", () => {
    expect(prefixFromSlug("upsell-group")).toBe("UPS");
    expect(prefixFromSlug("alura-style", ["ALU"])).toBe("ALS");
    expect(prefixFromSlug("alura", ["ALU"])).toBe("ALU2");
    expect(prefixFromSlug("me-company")).toBe("MEC");
    expect(prefixFromSlug("x")).toBe("COX");
    expect(taskKey("UPS", 1583)).toBe("UPS-1583");
    expect(parseTaskKey(" ups-1583 ")).toEqual({ prefix: "UPS", number: 1583 });
    expect(parseTaskKey("UPS 1583")).toBeNull();
  });
});

describe("description Markdown", () => {
  const src = "# Plan\nDo **this** now\n\n- one\n- two\n1. first\n2. second\n- [ ] check A\n- [x] check B\n<script>x</script>";
  it("parses headings, bold, lists, checkboxes; HTML stays text", () => {
    const b = parseMarkdown(src);
    expect(b.map((x) => x.kind)).toEqual(["heading", "paragraph", "bullets", "numbers", "checks", "paragraph"]);
    expect(b[1]).toEqual({ kind: "paragraph", content: [{ kind: "text", text: "Do " }, { kind: "bold", text: "this" }, { kind: "text", text: " now" }] });
    expect(b[5]).toEqual({ kind: "paragraph", content: [{ kind: "text", text: "<script>x</script>" }] });
    expect(checkboxProgress(src)).toEqual({ done: 1, total: 2 });
  });
  it("toggles one checkbox line", () => {
    const next = toggleCheckbox(src, 7);
    expect(checkboxProgress(next)).toEqual({ done: 2, total: 2 });
    expect(toggleCheckbox(next, 7)).toBe(src);
    expect(toggleCheckbox(src, 0)).toBe(src);
  });
});

describe("the Tasks URL", () => {
  it("defaults to Active, grouped by status, ordered by priority", () => {
    const p = parseTaskListParams({});
    expect(p).toMatchObject({ view: "active", group: "status", order: "priority", hidden: ["updated"], statusScope: ["in_review", "in_progress", "todo"] });
    expect(p.filters).toMatchObject({ status: "active" });
    expect(p.query).toEqual({});
  });
  it("reads filters (comma lists), drops bad values, keeps old links working", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const p = parseTaskListParams({ view: "backlog", status: "todo,bogus,waiting", priority: "normal,urgent", label: `${id},x`, estimate: "5,4,0", due: "overdue", over: "1", who: "me", group: "assignee", hide: "none" });
    expect(p.filters).toMatchObject({ statuses: ["todo", "in_review"], priorities: ["medium", "urgent"], labelIds: [id], estimates: [5, 0], due: ["overdue"], overEstimate: true, view: "mine" });
    expect(p.filters.status).toBeUndefined();
    expect(p.statusScope).toEqual(["todo", "in_review"]);
    expect(p.hidden).toEqual([]);
    expect(parseTaskListParams({ view: "company", status: "overdue" }).filters).toMatchObject({ status: "active", due: ["overdue"] });
    expect(parseTaskListParams({ status: "any" }).view).toBe("all");
    expect(parseTaskListParams({ view: "assigned" }).who).toBe("me");
    expect(parseTaskListParams({ who: `person:${id}` }).filters.assignees).toEqual([`person:${id}`]);
    expect(parseTaskListParams({ company: id }).companyId).toBe(id);
  });
});

describe("grouping and ordering of the list", () => {
  const task = (over: Partial<TaskItem>): TaskItem => ({
    id: Math.random().toString(36).slice(2),
    key: "K-1",
    title: "T",
    notes: null,
    visibility: "shared",
    status: "todo",
    priority: "none",
    estimate: null,
    needsReview: true,
    dueDate: null,
    ownerUserId: "u",
    ownerName: "N",
    company: null,
    project: null,
    assignee: null,
    labels: [],
    isOverdue: false,
    overEstimate: false,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  });
  it("status groups in Linear's order (scope groups shown even when empty), priority order inside", () => {
    const list = [task({ title: "low", priority: "low" }), task({ title: "urgent", priority: "urgent" }), task({ title: "rev", status: "in_review", estimate: 3 })];
    const g = groupTasks(list, "status", "priority", ["in_review", "in_progress", "todo"]);
    expect(g.map((x) => [x.key, x.tasks.length])).toEqual([["in_review", 1], ["in_progress", 0], ["todo", 2]]);
    expect(g[2]!.tasks.map((t) => t.title)).toEqual(["urgent", "low"]);
    expect(g[0]!.preset).toEqual({ status: "in_review" });
  });
  it("by assignee (No assignee last) and by due date", () => {
    const a = task({ title: "a", assignee: { kind: "person", id: "p1", name: "Zed" }, dueDate: "2026-11-05" });
    const b = task({ title: "b", assignee: { kind: "user", id: "u1", name: "Amir" }, dueDate: "2026-11-03" });
    const c = task({ title: "c" });
    expect(groupTasks([a, b, c], "assignee", "due").map((x) => x.label)).toEqual(["Amir", "Zed", "No assignee"]);
    expect(groupTasks([a, b, c], "none", "due")[0]!.tasks.map((t) => t.title)).toEqual(["b", "a", "c"]);
  });
});
