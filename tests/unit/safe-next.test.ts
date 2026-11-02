import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext (post-login redirect)", () => {
  it("keeps in-app paths with query and hash", () => {
    expect(safeNext("/tasks")).toBe("/tasks");
    expect(safeNext("/tasks?view=my&q=a%20b")).toBe("/tasks?view=my&q=a%20b");
    expect(safeNext("/companies/kiwi-go#projects")).toBe("/companies/kiwi-go#projects");
    expect(safeNext("/a/../b")).toBe("/b");
  });

  it("rejects anything that could leave the site", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "tasks",
      "https://evil.com",
      "//evil.com",
      "///evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "\\\\evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r//evil.com",
      "/%0a",
      "javascript:alert(1)",
      "/" + "a".repeat(3000),
    ]) {
      const out = safeNext(bad);
      // "/%0a" is a harmless encoded path segment and is allowed; everything else must be "/".
      if (bad === "/%0a") expect(out).toBe("/%0a");
      else expect(out, JSON.stringify(bad)).toBe("/");
    }
  });
});
