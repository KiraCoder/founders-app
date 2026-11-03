import { describe, expect, it } from "vitest";
import {
  DIVISION_DISPLAY_ORDER,
  KIWI_GO_ORG,
  orgExpertFindings,
  orgExpertSummaryLine,
  placeAt,
  VYSOTSKY_TEMPLATE,
  type OrgCheckInput,
} from "@/lib/org";

const dep = (n: number, over: Partial<OrgCheckInput["departments"][number]> = {}): OrgCheckInput["departments"][number] => ({
  id: `d${n}`,
  number: n,
  name: `Отдел ${n}`,
  headPersonId: "p1",
  ckp: "ЦКП",
  statistic: "Стат",
  metric: null,
  overdueTasks: 0,
  ...over,
});

const base = (over: Partial<OrgCheckInput> = {}): OrgCheckInput => ({
  hasChart: true,
  divisions: [{ id: "v7", number: 7, name: "Административное", headPersonId: "p1" }],
  departments: [dep(21)],
  functions: [{ id: "f1", text: "Связь с учредителями", responsiblePersonId: "p1" }],
  personNames: { p1: "Асель", p2: "Бакыт" },
  ...over,
});

describe("templates", () => {
  it("Vysotsky 7/21 places departments 1–21 in the standard divisions, shown 7, 1 … 6", () => {
    expect(VYSOTSKY_TEMPLATE.map((d) => d.number)).toEqual([...DIVISION_DISPLAY_ORDER]);
    expect(VYSOTSKY_TEMPLATE.map((d) => d.departments.map((x) => x.number))).toEqual([[21, 20, 19], [1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15], [16, 17, 18]]);
    expect(VYSOTSKY_TEMPLATE.map((d) => d.name)).toEqual(["Административное", "Персонал", "Коммерческое", "Финансы", "Производство", "Качество", "Расширение"]);
    expect(VYSOTSKY_TEMPLATE.every((d) => d.nameIsDefault && d.departments.every((x) => x.nameIsDefault && !x.ckp && !x.functions))).toBe(true);
  });
  it("the Kiwi Go chart has all 21 departments, each number once", () => {
    const numbers = KIWI_GO_ORG.flatMap((d) => d.departments.map((x) => x.number)).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(KIWI_GO_ORG.flatMap((d) => d.departments).reduce((n, d) => n + (d.functions?.length ?? 0), 0)).toBe(43);
  });
  it("placeAt moves an item to a clamped position", () => {
    expect(placeAt(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(placeAt(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(placeAt(["a", "b"], "x", 99)).toEqual(["a", "b", "x"]);
    expect(placeAt(["a", "b"], "x", -3)).toEqual(["x", "a", "b"]);
  });
});

describe("Org Structure Expert rules", () => {
  it("a complete chart has no findings", () => {
    expect(orgExpertFindings(base())).toEqual([]);
  });

  it("no chart → one info finding", () => {
    expect(orgExpertFindings({ ...base(), hasChart: false })).toMatchObject([{ rule: "no_chart", severity: "info" }]);
  });

  it("flags missing heads, ЦКП, statistic — one grouped finding per rule", () => {
    const f = orgExpertFindings(
      base({
        divisions: [
          { id: "v1", number: 1, name: "Персонал", headPersonId: null },
          { id: "v7", number: 7, name: "Административное", headPersonId: null },
        ],
        departments: [dep(1, { headPersonId: null, ckp: " " }), dep(2, { headPersonId: null, statistic: "" }), dep(3)],
      }),
    );
    expect(f.map((x) => [x.rule, x.count])).toEqual([
      ["division_no_head", 2],
      ["department_no_head", 2],
      ["department_no_ckp", 1],
      ["department_no_statistic", 1],
    ]);
    expect(f[0]).toMatchObject({ severity: "warning", text: "2 divisions have no head assigned", items: ["7 Административное", "1 Персонал"] });
    expect(f[2]!.text).toBe("1 department has no ЦКП");
  });

  it("flags a person heading more than N departments (default 4, tunable)", () => {
    const departments = [1, 2, 3, 4, 5].map((n) => dep(n, { headPersonId: "p2" }));
    expect(orgExpertFindings(base({ departments }))).toMatchObject([
      { rule: "head_overloaded", count: 1, text: "Бакыт (5) heads more than 4 departments", ids: ["d1", "d2", "d3", "d4", "d5"] },
    ]);
    expect(orgExpertFindings(base({ departments: departments.slice(0, 4) }))).toEqual([]);
    expect(orgExpertFindings(base({ departments: departments.slice(0, 3) }), { maxDepartmentsPerHead: 2 })[0]).toMatchObject({ rule: "head_overloaded" });
  });

  it("flags stale linked numbers and 5+ overdue tasks; functions without a responsible person are info only", () => {
    const f = orgExpertFindings(
      base({
        departments: [
          dep(7, { metric: { label: "Revenue", freshness: "stale" } }),
          dep(8, { metric: { label: "COD", freshness: "fresh" } }),
          dep(9, { overdueTasks: 5 }),
          dep(10, { overdueTasks: 4 }),
        ],
        functions: [
          { id: "f1", text: "a", responsiblePersonId: null },
          { id: "f2", text: "b", responsiblePersonId: "p1" },
        ],
      }),
    );
    expect(f.map((x) => [x.rule, x.severity, x.items])).toEqual([
      ["metric_stale", "warning", ["7 Отдел 7 · Revenue"]],
      ["overdue_tasks", "warning", ["9 Отдел 9 (5)"]],
      ["function_no_responsible", "info", ["a"]],
    ]);
  });
});

describe("the weekly summary line", () => {
  const findings = orgExpertFindings(
    base({
      divisions: [{ id: "v7", number: 7, name: "Административное", headPersonId: null }],
      departments: [dep(1, { headPersonId: null, ckp: "" }), dep(2, { metric: { label: "Revenue", freshness: "missing" } })],
      functions: [{ id: "f1", text: "a", responsiblePersonId: null }],
    }),
  );

  it("is ONE line for all companies, warnings only, without stale numbers (Numbers waiting asks for those)", () => {
    const line = orgExpertSummaryLine(
      [
        { companyName: "Kiwi Go", findings },
        { companyName: "Jobutify", findings: orgExpertFindings(base({ departments: [dep(4, { statistic: "" })] })) },
      ],
      "https://app.example/org",
    );
    expect(line).toBe("Org Structure Expert (weekly): Kiwi Go: 1 without a head (divisions), 1 without a head +1 more; Jobutify: 1 without a statistic — https://app.example/org");
    expect(line).not.toMatch(/stale|responsible/);
  });

  it("is null when only info / stale-number findings remain", () => {
    const quiet = orgExpertFindings(
      base({ departments: [dep(2, { metric: { label: "Revenue", freshness: "missing" } })], functions: [{ id: "f", text: "x", responsiblePersonId: null }] }),
    );
    expect(orgExpertSummaryLine([{ companyName: "Kiwi Go", findings: quiet }], "/org")).toBeNull();
    expect(orgExpertSummaryLine([], "/org")).toBeNull();
  });

  it("names at most 3 companies", () => {
    const many = ["A", "B", "C", "D", "E"].map((companyName) => ({ companyName, findings }));
    expect(orgExpertSummaryLine(many, "/org")).toMatch(/; \+2 more companies — \/org$/);
  });
});
