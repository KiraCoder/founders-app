import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyButton } from "@/components/CopyButton";
import { ShortcutsModal } from "@/components/shell/ShortcutsModal";

describe("UI Helpers and Shell Enhancements", () => {
  describe("CopyButton", () => {
    it("renders button with copy icon and accessible title", () => {
      const html = renderToStaticMarkup(
        createElement(CopyButton, {
          text: "0123-abc-digest",
          title: "Copy reference",
        })
      );
      expect(html).toContain("<button");
      expect(html).toContain('title="Copy reference"');
      expect(html).toContain("<svg");
    });
  });

  describe("ShortcutsModal", () => {
    it("renders trigger button with question mark shortcut key", () => {
      const html = renderToStaticMarkup(createElement(ShortcutsModal));
      expect(html).toContain("<button");
      expect(html).toContain("?");
      expect(html).toContain('aria-label="Keyboard shortcuts"');
    });
  });
});
