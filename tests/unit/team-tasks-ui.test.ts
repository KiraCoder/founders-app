/** Team view markup: header (person link, Telegram status), counts with overdue in red, stacking grid. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/actions", () => ({
  createTaskAction: vi.fn(),
  updateTaskAction: vi.fn(),
  deleteTaskAction: vi.fn(),
  setTaskDeadlineAction: vi.fn(),
  setTaskStatusAction: vi.fn(),
}));

const { TeamBoard, TeamCountsLine } = await import("@/components/tasks/TeamBoard");

const options = { currentUserId: "u1", companies: [], projects: [], founders: [], peopleByCompany: {}, departmentsByCompany: {} };
const counts = { open: 2, overdue: 1, dueToday: 1, waiting: 1, doneRecent: 3 };

describe("Team view markup", () => {
  it("counts line marks overdue red only when there is something overdue", () => {
    const html = renderToStaticMarkup(createElement(TeamCountsLine, { counts }));
    expect(html).toMatch(/tag tag-risk"><span class="num" data-count="overdue">1</);
    const none = renderToStaticMarkup(createElement(TeamCountsLine, { counts: { ...counts, overdue: 0 } }));
    expect(none).not.toContain("tag-risk");
  });

  it("group header links to the person page and shows the Telegram status; groups stack on a phone", () => {
    const html = renderToStaticMarkup(
      createElement(TeamBoard, {
        today: "2026-11-02",
        options,
        groups: [
          { key: "person:p1", kind: "person", id: "p1", name: "Elmurat", personId: "p1", companyId: null, left: false, telegram: "paused", counts, tasks: [] },
          { key: "unassigned", kind: "unassigned", id: null, name: "Unassigned", personId: null, companyId: null, left: false, telegram: null, counts, tasks: [] },
        ],
      }),
    );
    expect(html).toContain('href="/people/p1"');
    expect(html).toContain('data-state="paused"');
    expect(html).toContain("Telegram paused");
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("lg:grid-cols-2");
    expect(html).toContain("No unassigned tasks.");
  });
});
