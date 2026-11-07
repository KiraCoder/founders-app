import { describe, expect, it } from "vitest";
import {
  COMPANY_COOKIE,
  activeCompanySection,
  companyCookie,
  companySections,
  companySlugFromPath,
  currentCompanySlug,
  parseCollapsed,
  readCookie,
} from "@/components/shell/company-nav";

const companies = [{ slug: "kiwi-go" }, { slug: "barbol" }];

describe("companySlugFromPath", () => {
  it("reads the slug from company pages and their sub-pages", () => {
    expect(companySlugFromPath("/companies/kiwi-go")).toBe("kiwi-go");
    expect(companySlugFromPath("/companies/kiwi-go/numbers")).toBe("kiwi-go");
    expect(companySlugFromPath("/companies/caf%C3%A9")).toBe("café");
  });
  it("is null elsewhere", () => {
    expect(companySlugFromPath("/companies")).toBeNull();
    expect(companySlugFromPath("/companies/")).toBeNull();
    expect(companySlugFromPath("/tasks")).toBeNull();
    expect(companySlugFromPath("/")).toBeNull();
    expect(companySlugFromPath(null)).toBeNull();
  });
});

describe("currentCompanySlug", () => {
  it("prefers the company in the URL", () => {
    expect(currentCompanySlug("/companies/barbol", "kiwi-go", companies)).toBe("barbol");
  });
  it("falls back to the cookie on global pages", () => {
    expect(currentCompanySlug("/tasks", "kiwi-go", companies)).toBe("kiwi-go");
    expect(currentCompanySlug("/companies", "barbol", companies)).toBe("barbol");
  });
  it("ignores unknown (archived/inaccessible) slugs in the URL or cookie", () => {
    expect(currentCompanySlug("/companies/gone", "kiwi-go", companies)).toBe("kiwi-go");
    expect(currentCompanySlug("/tasks", "gone", companies)).toBeNull();
    expect(currentCompanySlug("/tasks", null, companies)).toBeNull();
    expect(currentCompanySlug("/", "", companies)).toBeNull();
  });
});

describe("cookie helpers", () => {
  it("reads the remembered company out of a cookie string", () => {
    expect(readCookie(`a=1; ${COMPANY_COOKIE}=kiwi-go; b=2`, COMPANY_COOKIE)).toBe("kiwi-go");
    expect(readCookie(`${COMPANY_COOKIE}=caf%C3%A9`, COMPANY_COOKIE)).toBe("café");
    expect(readCookie(`x${COMPANY_COOKIE}=nope`, COMPANY_COOKIE)).toBeNull();
    expect(readCookie(`${COMPANY_COOKIE}=`, COMPANY_COOKIE)).toBeNull();
    expect(readCookie("", COMPANY_COOKIE)).toBeNull();
    expect(readCookie(undefined, COMPANY_COOKIE)).toBeNull();
  });
  it("writes and clears the cookie", () => {
    expect(companyCookie("kiwi-go")).toMatch(/^fc-company=kiwi-go; Path=\/; SameSite=Lax; Max-Age=\d+$/);
    expect(companyCookie(null)).toContain("Max-Age=0");
    const written = companyCookie("café").split(";")[0]!;
    expect(readCookie(written, COMPANY_COOKIE)).toBe("café");
  });
});

describe("company sections", () => {
  it("links to the company page tabs", () => {
    const s = companySections("kiwi-go");
    expect(s.map((x) => x.label)).toEqual(["Overview", "Tasks", "Projects", "People", "Org", "Numbers", "AI roles"]);
    expect(s[0]!.href).toBe("/companies/kiwi-go");
    expect(s.find((x) => x.key === "ai")!.href).toBe("/companies/kiwi-go?tab=ai");
    expect(s.find((x) => x.key === "org")!.href).toBe("/companies/kiwi-go?tab=org");
  });
  it("knows which section is active", () => {
    expect(activeCompanySection("/companies/kiwi-go", null, "kiwi-go")).toBe("overview");
    expect(activeCompanySection("/companies/kiwi-go", "bogus", "kiwi-go")).toBe("overview");
    expect(activeCompanySection("/companies/kiwi-go", "people", "kiwi-go")).toBe("people");
    expect(activeCompanySection("/companies/kiwi-go/numbers", null, "kiwi-go")).toBe("numbers");
    expect(activeCompanySection("/companies/barbol", "people", "kiwi-go")).toBeNull();
    expect(activeCompanySection("/tasks", "people", "kiwi-go")).toBeNull();
  });
});

describe("parseCollapsed", () => {
  it("only '1' means collapsed", () => {
    expect(parseCollapsed("1")).toBe(true);
    expect(parseCollapsed("0")).toBe(false);
    expect(parseCollapsed(null)).toBe(false);
  });
});
