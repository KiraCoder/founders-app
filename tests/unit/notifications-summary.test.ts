import { describe, expect, it } from "vitest";
import { buildEveningCheck, buildMorningSummary, type ParkedItem } from "@/server/notifications/messages";
import { fitTelegram, renderTelegram, renderTelegramText, TELEGRAM_MAX_TEXT } from "@/server/notifications/render-telegram";
import { aiRequestRef, holdingRef, parkedRef, type NeutralMessage } from "@/server/notifications/types";
import type { TaskView, TodaySummary } from "@/server/services/tasks";

/** An 80-character title, like the reviewer's repro. */
const title80 = (i: number) => `Follow up with the supplier about the delayed fabric shipment number ${String(i).padStart(3, "0")} pls`.slice(0, 80);

function task(i: number, dueDate: string): TaskView {
  return {
    id: `t${i}`,
    title: title80(i),
    dueDate,
    priority: "normal",
    visibility: "shared",
    company: { name: "Alura Style" },
    status: "todo",
  } as unknown as TaskView;
}

/** Reviewer's repro: 12 overdue + 4 today + 10 this week + 8 personal + 6 parked, 80-char titles. */
function repro() {
  const today = "2026-11-16";
  const s = {
    today,
    overdue: Array.from({ length: 12 }, (_, i) => task(i, "2026-11-01")),
    dueToday: Array.from({ length: 4 }, (_, i) => task(100 + i, today)),
    thisWeek: Array.from({ length: 10 }, (_, i) => task(200 + i, "2026-11-19")),
    personal: Array.from({ length: 8 }, (_, i) => ({ ...task(300 + i, "2026-11-30"), company: null, visibility: "private" })),
  } as unknown as TodaySummary;
  const parked: ParkedItem[] = Array.from({ length: 6 }, (_, i) => ({
    text: `Report ready: Financial Analyst · Company ${i} · October 2026 (${title80(i)})`,
    refs: [parkedRef(`row${i}`)],
  }));
  const holding = {
    lines: [
      { text: "Holding · акты", style: "heading" as const },
      { text: "Ask Elmurat for 3 missing акты: Alura Style → Alura Brand (Sep, Oct)", style: "item" as const, refs: [holdingRef("ask1")] },
    ],
    actions: [{ action: "holding_asked" as const, askId: "ask1", label: "I asked Elmurat" }],
  };
  const ai = [
    { text: "AI roles · numbers needed", style: "heading" as const },
    { text: "Financial Analyst needs October 2026 numbers for Kiwi Go: Revenue", style: "item" as const, refs: [aiRequestRef("req1")] },
  ];
  return buildMorningSummary(s, parked, "Talant", [{ companyName: "Kiwi Go", label: "Revenue", hasData: true }], holding, ai);
}

describe("morning summary fits Telegram (whole-app review #1)", () => {
  it("keeps the Holding ask and AI requests (first, after the header) and budgets the task sections", () => {
    const m = repro();
    const text = renderTelegramText(m);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    // Action items come right after the counts line.
    expect(m.lines[1]!.text).toBe("Holding · акты");
    expect(text).toContain("Ask Elmurat for 3 missing акты");
    expect(text).toContain("Financial Analyst needs October 2026 numbers");
    expect(text.indexOf("Holding")).toBeLessThan(text.indexOf("Overdue (12)"));
    // Parked items and "Numbers waiting" are kept whole.
    expect(text).toContain("Parked reminders (6)");
    expect(text).toContain("Numbers waiting (1)");
    // Task sections end with "+N more — open the app" instead of being cut off.
    expect(text).toMatch(/\+\d+ more — open the app/);
    expect(text).not.toMatch(/…$/);

    const fit = fitTelegram(m);
    expect(fit.message).toBe(m); // nothing had to be dropped
    expect(fit.keptRefs.has(holdingRef("ask1"))).toBe(true);
    expect(fit.keptRefs.has(aiRequestRef("req1"))).toBe(true);
    for (let i = 0; i < 6; i++) expect(fit.keptRefs.has(parkedRef(`row${i}`))).toBe(true);
    expect(renderTelegram(fit.message, { "holding_asked:ask1": "a:tok" }).reply_markup?.inline_keyboard.flat()).toHaveLength(1);
  });

  it("counts every task either as a line or in '+N more'", () => {
    const m = repro();
    const sections = ["Overdue (12)", "Due today (4)", "Due this week (10)", "My personal todos (8)"];
    for (const h of sections) {
      const i = m.lines.findIndex((l) => l.text === h);
      if (i < 0) continue; // a section may be reduced to nothing only if the budget is gone
      const total = Number(/\((\d+)\)/.exec(h)![1]);
      let items = 0;
      let more = 0;
      for (const l of m.lines.slice(i + 1)) {
        if (l.style === "heading") break;
        if (l.style === "item") items++;
        const mm = /^\+(\d+) more — open the app$/.exec(l.text);
        if (mm) more = Number(mm[1]);
      }
      expect(items + more).toBe(total);
    }
  });
});

describe("fitTelegram", () => {
  it("drops whole lines from the end and reports which refs made it", () => {
    const msg: NeutralMessage = {
      title: "Long",
      lines: Array.from({ length: 200 }, (_, i) => ({ text: `${"x".repeat(60)} ${i} & more`, style: "item" as const, refs: [`p:${i}`] })),
      actions: [
        { action: "holding_asked", askId: "early", label: "A" },
        { action: "holding_asked", askId: "late", label: "B" },
      ],
    };
    msg.lines[0]!.refs!.push(holdingRef("early"));
    msg.lines[199]!.refs!.push(holdingRef("late"));
    const fit = fitTelegram(msg);
    expect(renderTelegramText(fit.message).length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(fit.message.lines.at(-1)!.text).toBe("…");
    expect(fit.keptRefs.has("p:0")).toBe(true);
    expect(fit.keptRefs.has("p:199")).toBe(false);
    expect(fit.droppedRefs.has("p:199")).toBe(true);
    const kept = fit.message.lines.length - 1;
    expect([...fit.keptRefs].filter((r) => r.startsWith("p:"))).toHaveLength(kept);
    // A holding button whose line was left out is removed with it.
    expect(fit.message.actions?.map((a) => a.askId)).toEqual(["early"]);
  });
});

describe("parked reminders are not repeated (whole-app review #5)", () => {
  const today = "2026-11-16";
  const s = (overdue: TaskView[], dueToday: TaskView[] = []) =>
    ({ today, overdue, dueToday, thisWeek: [], personal: [] }) as unknown as TodaySummary;

  it("drops parked lines for tasks listed in a section and bundles them with that line", () => {
    const overdue = Array.from({ length: 10 }, (_, i) => task(i, "2026-11-01"));
    const parked: ParkedItem[] = [
      { text: "Overdue: shown task", taskId: "t1", refs: [parkedRef("r1"), parkedRef("r1b")] },
      // t9 is behind "+2 more" (8 per section), so it stays a parked line.
      { text: "Overdue: hidden task", taskId: "t9", refs: [parkedRef("r9")] },
      { text: "Report ready: Financial Analyst · Kiwi Go · October 2026 (1 info)", refs: [parkedRef("rep")] },
    ];
    const m = buildMorningSummary(s(overdue), parked, "Nuraaly");
    const text = renderTelegramText(m);
    expect(text).toContain("Parked reminders (2)");
    expect(text).not.toContain("shown task");
    expect(text).toContain("Overdue: hidden task");
    const fit = fitTelegram(m);
    for (const r of ["r1", "r1b", "r9", "rep"]) expect(fit.keptRefs.has(parkedRef(r))).toBe(true);
    expect(m.lines.find((l) => l.text.startsWith(title80(1)))?.refs).toEqual([parkedRef("r1"), parkedRef("r1b")]);
  });

  it("the evening check does not repeat a due-today task in Parked reminders", () => {
    const due = task(5, today);
    const m = buildEveningCheck(s([], [due]), [{ text: "Due today: x", taskId: "t5", refs: [parkedRef("p5")] }])!;
    expect(renderTelegramText(m)).not.toContain("Parked reminders");
    expect(fitTelegram(m).keptRefs.has(parkedRef("p5"))).toBe(true);
  });
});

describe("evening check only when there is something new to say (whole-app review #6)", () => {
  const today = "2026-11-16";
  const s = (overdue: TaskView[], dueToday: TaskView[] = []) =>
    ({ today, overdue, dueToday, thisWeek: [], personal: [] }) as unknown as TodaySummary;

  it("is not sent for overdue tasks alone", () => {
    expect(buildEveningCheck(s([task(1, "2026-11-01"), task(2, "2026-11-02")]), [])).toBeNull();
  });

  it("is sent when something due today is still open (overdue count as a note)", () => {
    const m = buildEveningCheck(s([task(1, "2026-11-01")], [task(5, today)]), [])!;
    expect(renderTelegramText(m)).toContain("Still open today (1)");
    expect(renderTelegramText(m)).toContain("1 overdue task(s) still waiting");
  });

  it("is sent when parked items wait that no summary listed yet", () => {
    const m = buildEveningCheck(s([task(1, "2026-11-01")]), [{ text: "Overdue: x — 15d overdue", taskId: "t1", refs: [parkedRef("p1")] }])!;
    expect(renderTelegramText(m)).toContain("Parked reminders (1)");
  });
});
