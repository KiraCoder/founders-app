import { describe, expect, it } from "vitest";
import { escapeHtml, renderTelegram, renderTelegramText, TELEGRAM_MAX_TEXT } from "@/server/notifications/render-telegram";
import { actionKey, type NeutralMessage } from "@/server/notifications/types";

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
