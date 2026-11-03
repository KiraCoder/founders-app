import { describe, expect, it } from "vitest";
import { buildGroupedChase } from "@/server/notifications/messages";
import { escapeHtml, fitTelegram, renderTelegram, renderTelegramText, TELEGRAM_MAX_TEXT } from "@/server/notifications/render-telegram";
import { actionKey, taskRef, type NeutralMessage } from "@/server/notifications/types";

describe("Telegram renderer", () => {
  it("escapes HTML in every piece of user text", () => {
    expect(escapeHtml(`<b>"Tom & Jerry"</b>`)).toBe(`&lt;b&gt;"Tom &amp; Jerry"&lt;/b&gt;`);
    const msg: NeutralMessage = {
      title: "Pay <script>alert(1)</script> & co",
      lines: [
        { text: "Section <i>", style: "heading" },
        { text: "Item with <a href='x'>link</a>", style: "item" },
        { text: "muted & quiet", style: "muted" },
      ],
    };
    const text = renderTelegramText(msg);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<a href");
    expect(text).toContain("<b>Pay &lt;script&gt;alert(1)&lt;/script&gt; &amp; co</b>");
    expect(text).toContain("<b>Section &lt;i&gt;</b>");
    expect(text).toContain("• Item with &lt;a href='x'&gt;link&lt;/a&gt;");
    expect(text).toContain("<i>muted &amp; quiet</i>");
  });

  it("uses HTML parse mode and only shows buttons that have a server-side token", () => {
    const msg: NeutralMessage = {
      title: "Overdue 1 day",
      lines: [{ text: "Task" }],
      actions: [
        { action: "done", taskId: "t1", label: "Done" },
        { action: "snooze_1d", taskId: "t1", label: "Snooze 1 day" },
        { action: "move_1d", taskId: "t1", label: "Deadline +1 day" },
      ],
    };
    expect(renderTelegram(msg).reply_markup).toBeUndefined();
    const r = renderTelegram(msg, {
      [actionKey({ action: "done", taskId: "t1" })]: "a:tok1",
      [actionKey({ action: "move_1d", taskId: "t1" })]: "a:tok3",
    });
    expect(r.parse_mode).toBe("HTML");
    expect(r.reply_markup?.inline_keyboard).toEqual([
      [
        { text: "Done", callback_data: "a:tok1" },
        { text: "Deadline +1 day", callback_data: "a:tok3" },
      ],
    ]);
    // Callback data never contains the raw task id.
    expect(JSON.stringify(r.reply_markup)).not.toContain("t1");
  });

  it("stays under Telegram's length limit without cutting an entity", () => {
    const msg: NeutralMessage = {
      title: "Long",
      lines: Array.from({ length: 800 }, (_, i) => ({ text: `line ${i} & more`, style: "item" as const })),
    };
    const text = renderTelegramText(msg);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(text).not.toMatch(/&[a-z]*$/);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("grouped overdue push", () => {
  const task = (id: string, title: string) => ({
    id,
    title,
    dueDate: "2026-11-01" as const,
    company: { id: "c1", slug: "kiwi-go", name: "Kiwi Go", color: "#000" },
    priority: "normal" as const,
    visibility: "shared" as const,
  });

  it("numbers the tasks, one keyboard row of Done / +1 day / +3 days per task", () => {
    const { message, listed } = buildGroupedChase([task("t1", "First"), task("t2", "Second")], "2026-11-02");
    expect(message.title).toBe("2 tasks need a new deadline");
    expect(listed).toEqual(["t1", "t2"]);
    expect(message.lines[0]).toMatchObject({ text: "1. First — Kiwi Go · 1d overdue", refs: [taskRef("t1")] });
    const callbacks = Object.fromEntries((message.actions ?? []).map((a, i) => [actionKey(a), `a:tok${i}`]));
    const kb = renderTelegram(message, callbacks).reply_markup!.inline_keyboard;
    expect(kb.map((r) => r.map((b) => b.text))).toEqual([
      ["1 · Done", "1 · +1 day", "1 · +3 days"],
      ["2 · Done", "2 · +1 day", "2 · +3 days"],
    ]);
    expect(buildGroupedChase([task("t1", "Only")], "2026-11-02").message.title).toBe("1 task needs a new deadline");
  });

  it("budgets the task lines so '+N more' and the footer always survive (nothing left for fitTelegram to cut)", () => {
    const long = "&".repeat(300); // 1 500 rendered characters per line
    const tasks = Array.from({ length: 5 }, (_, i) => task(`t${i}`, `${i} ${long}`));
    const { message, listed } = buildGroupedChase(tasks, "2026-11-02");
    expect(message.title).toBe("5 tasks need a new deadline");
    expect(listed).toEqual(["t0", "t1"]);
    expect(message.lines.map((l) => l.text.slice(0, 3))).toEqual(["1. ", "2. ", "+3 ", "Don"]);
    expect(message.lines.at(-2)!.text).toBe("+3 more — open the app");
    expect(message.lines.at(-1)!.text).toBe("Done closes a task; +1 day / +3 days moves its deadline.");
    expect(message.actions!.map((a) => a.taskId)).toEqual(["t0", "t0", "t0", "t1", "t1", "t1"]);
    const fitted = fitTelegram(message);
    expect(fitted.message).toBe(message); // already fits: unchanged
    expect(renderTelegram(message).text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
  });

  it("fitTelegram drops the buttons of a task whose line was cut", () => {
    const long = "x".repeat(2500);
    const message: NeutralMessage = {
      title: "2 tasks need a new deadline",
      lines: [
        { text: `1. ${long}`, style: "text", refs: [taskRef("t1")] },
        { text: `2. ${long}`, style: "text", refs: [taskRef("t2")] },
      ],
      actions: ["t1", "t2"].flatMap((id) => [{ action: "done" as const, taskId: id, label: "Done" }]),
    };
    const fitted = fitTelegram(message);
    expect(fitted.keptRefs.has(taskRef("t1"))).toBe(true);
    expect(fitted.keptRefs.has(taskRef("t2"))).toBe(false);
    expect(fitted.message.actions!.every((a) => a.taskId === "t1")).toBe(true);
    // Messages without task refs keep their task buttons (single-task pushes).
    const single: NeutralMessage = { title: "x", lines: [{ text: long }, { text: long }], actions: [{ action: "done", taskId: "t9", label: "Done" }] };
    expect(fitTelegram(single).message.actions).toHaveLength(1);
  });

});
