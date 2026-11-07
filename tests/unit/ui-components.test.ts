import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, InitialsAvatar, Skeleton, StatusDot, avatarFontSize, getInitials } from "@/components/ui";

describe("UI primitives (design system)", () => {
  describe("getInitials", () => {
    it("handles two-word names in Latin and Cyrillic", () => {
      expect(getInitials("Nuraaly Toktonazar uulu")).toBe("NT");
      expect(getInitials("Talantbek Zhenishbek")).toBe("TZ");
      expect(getInitials("Эльмурат Касымов")).toBe("ЭК");
      expect(getInitials("Эдил Темиров")).toBe("ЭТ");
    });

    it("handles single-word names and empty edge cases", () => {
      expect(getInitials("Admin")).toBe("AD");
      expect(getInitials("A")).toBe("A");
      expect(getInitials("")).toBe("");
      expect(getInitials("   ")).toBe("");
    });
  });

  describe("InitialsAvatar", () => {
    it("renders avatar markup with calculated font size and initials", () => {
      const html = renderToStaticMarkup(createElement(InitialsAvatar, { name: "Nuraaly Toktonazar", size: 32 }));
      expect(html).toContain("NT");
      expect(html).toContain("rounded-full");
      expect(html).toContain("width:32px");
      expect(html).toContain("height:32px");
    });

    it("fits 1–2 letters at every size: xs / sm / md presets, no border eating the circle, one centred line", () => {
      for (const [size, px] of [["xs", 16], ["sm", 20], ["md", 28]] as const) {
        const two = renderToStaticMarkup(createElement(InitialsAvatar, { name: "Nuraaly Toktonazar", size }));
        expect(two).toContain(`width:${px}px`);
        expect(two).toContain("leading-none");
        expect(two).toContain("whitespace-nowrap");
        expect(two).not.toMatch(/\bborder\b/);
        const font = Number(/font-size:([\d.]+)px/.exec(two)![1]);
        // Two bold letters are ~1.25 em wide: they must fit inside the circle with a margin.
        expect(font * 1.25).toBeLessThanOrEqual(px * 0.75);
        const one = renderToStaticMarkup(createElement(InitialsAvatar, { name: "Edil", size }));
        expect(one).toContain(">ED<");
      }
      expect(avatarFontSize(16, 2)).toBe(6.5);
      expect(avatarFontSize(28, 2)).toBe(11);
      expect(avatarFontSize(20, 1)).toBe(10);
    });
  });

  describe("StatusDot", () => {
    it("renders ok tone dot with optional pulse", () => {
      const html = renderToStaticMarkup(createElement(StatusDot, { tone: "ok", pulse: true }));
      expect(html).toContain("bg-accent");
      expect(html).toContain("animate-ping");
    });

    it("renders static warn dot without pulse", () => {
      const html = renderToStaticMarkup(createElement(StatusDot, { tone: "warn", pulse: false }));
      expect(html).toContain("bg-warn");
      expect(html).not.toContain("animate-ping");
    });
  });

  describe("Skeleton", () => {
    it("renders pulse element with dimensions", () => {
      const html = renderToStaticMarkup(createElement(Skeleton, { width: 120, height: 20 }));
      expect(html).toContain("animate-pulse");
      expect(html).toContain("width:120px");
      expect(html).toContain("height:20px");
    });
  });

  describe("EmptyState", () => {
    it("renders legacy children card seamlessly", () => {
      const html = renderToStaticMarkup(createElement(EmptyState, {}, "No tasks"));
      expect(html).toContain("card");
      expect(html).toContain("No tasks");
    });

    it("renders structured empty state with title and description", () => {
      const html = renderToStaticMarkup(
        createElement(EmptyState, {
          title: "Nothing here yet",
          description: "Create your first task to get started.",
        })
      );
      expect(html).toContain("Nothing here yet");
      expect(html).toContain("Create your first task to get started.");
    });
  });
});
