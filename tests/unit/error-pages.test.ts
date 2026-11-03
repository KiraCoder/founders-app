import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AppError from "@/app/(app)/error";
import RootError from "@/app/error";
import GlobalError from "@/app/global-error";
import NotFound from "@/app/not-found";

const secret = Object.assign(new Error("relation \"holding_files\" does not exist at Object.query (/var/task/node_modules/postgres/x.js:12)"), { digest: "123456789" });
const reset = () => undefined;

describe("branded error pages (whole-app review #9)", () => {
  for (const [name, Page] of [["app/error", RootError], ["app/(app)/error", AppError], ["app/global-error", GlobalError]] as const) {
    it(`${name}: plain English, Back to Today, reference only — never the error text or stack`, () => {
      const html = renderToStaticMarkup(createElement(Page, { error: secret, reset }));
      expect(html).toContain("This page could not be loaded");
      expect(html).toContain("Back to Today");
      expect(html).toContain('href="/"');
      expect(html).toContain("Reference: 123456789");
      expect(html).not.toContain("holding_files");
      expect(html).not.toContain("node_modules");
    });
  }

  it("global-error renders a whole document", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: secret, reset }));
    expect(html).toMatch(/^<html/);
    expect(html).toContain("<body");
  });

  it("not-found has the same Back to Today link", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain("Back to Today");
  });
});
