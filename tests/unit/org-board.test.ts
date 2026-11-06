import { describe, expect, it } from "vitest";
import {
  DIVISION_DISPLAY_ORDER,
  divisionTint,
  JOURNEY_TEMPLATES,
  journeyNumber,
  journeyTemplateFor,
  mergePost,
  peopleOnChart,
  personFootprint,
  postChipLabel,
  postCreateSchema,
  postPatchSchema,
} from "@/lib/org";

const ID = "00000000-0000-4000-8000-000000000001";
const DEPT = "00000000-0000-4000-8000-000000000002";

describe("posts: person or hiring, never both", () => {
  it("schemas refuse both at once and hiring without a role title", () => {
    expect(postCreateSchema.safeParse({ departmentId: DEPT, personId: ID, hiring: true, hiringRoleTitle: "X" }).success).toBe(false);
    expect(postCreateSchema.safeParse({ departmentId: DEPT, hiring: true }).success).toBe(false);
    expect(postCreateSchema.safeParse({ departmentId: DEPT, hiring: true, hiringRoleTitle: "Курьер" }).success).toBe(true);
    expect(postCreateSchema.safeParse({ departmentId: DEPT, personId: ID }).success).toBe(true);
    expect(postCreateSchema.safeParse({ departmentId: DEPT }).success).toBe(true);
    expect(postPatchSchema.safeParse({ personId: ID, hiring: true }).success).toBe(false);
    expect(postPatchSchema.safeParse({}).success).toBe(false);
    expect(postPatchSchema.safeParse({ personId: "" }).data).toEqual({ personId: null });
  });

  it("mergePost: picking a person ends hiring; hiring takes the person off", () => {
    const hiring = { title: "Кассир", personId: null, hiring: true, hiringRoleTitle: "Кассир COD" };
    expect(mergePost(hiring, { personId: ID })).toEqual({ title: "Кассир", personId: ID, hiring: false, hiringRoleTitle: null });
    const held = { title: "Кассир", personId: ID, hiring: false, hiringRoleTitle: null };
    expect(mergePost(held, { hiring: true, hiringRoleTitle: "Кассир" })).toEqual({ title: "Кассир", personId: null, hiring: true, hiringRoleTitle: "Кассир" });
    expect(mergePost(held, { title: "Старший кассир" })).toEqual({ ...held, title: "Старший кассир" });
    expect(mergePost(hiring, { hiring: false })).toEqual({ title: "Кассир", personId: null, hiring: false, hiringRoleTitle: null });
  });

  it("chip label: the holder's name, else the role being hired for, else the title", () => {
    expect(postChipLabel({ title: "Кассир", personName: "Айдай", hiring: false, hiringRoleTitle: null })).toBe("Айдай");
    expect(postChipLabel({ title: "Кассир", personName: null, hiring: true, hiringRoleTitle: "Кассир COD" })).toBe("Кассир COD");
    expect(postChipLabel({ title: "Кассир", personName: null, hiring: false, hiringRoleTitle: null })).toBe("Кассир");
    expect(postChipLabel({ title: "", personName: null, hiring: false, hiringRoleTitle: null })).toBe("Пост");
  });
});

describe("journey", () => {
  it("numbers are two digits; the Upsell template is offered to Upsell Group only", () => {
    expect([1, 9, 10].map(journeyNumber)).toEqual(["01", "09", "10"]);
    expect(journeyTemplateFor("upsell-group")).toBe("upsell");
    expect(journeyTemplateFor("kiwi-go")).toBeNull();
    expect(JOURNEY_TEMPLATES.upsell.steps).toHaveLength(9);
    expect(JOURNEY_TEMPLATES.upsell.steps[0]).toBe("Фабрика найдена");
    expect(JOURNEY_TEMPLATES.upsell.steps[8]).toBe("Деньги и 5% Upsell");
  });
});

describe("board look and «Показать посты»", () => {
  it("each division has its own tint", () => {
    const tints = DIVISION_DISPLAY_ORDER.map(divisionTint);
    expect(new Set(tints).size).toBe(7);
    tints.forEach((t) => expect(t).toMatch(/^#[0-9a-f]{6}$/));
  });

  const chart = {
    divisions: [
      {
        id: "v7",
        headPersonId: "p1",
        headName: "Нуралы",
        departments: [
          { id: "d21", headPersonId: "p1", headName: "Нуралы", functions: [{ id: "f1", responsiblePersonId: "p2", responsibleName: "Элмурат" }], posts: [] },
          { id: "d20", headPersonId: null, headName: null, functions: [], posts: [{ id: "s1", personId: "p2", personName: "Элмурат" }] },
          { id: "d19", headPersonId: null, headName: null, functions: [{ id: "f2", responsiblePersonId: null }], posts: [{ id: "s2", personId: null }] },
        ],
      },
    ],
  };

  it("personFootprint: heads, functions and posts of one person; the departments they touch", () => {
    const p2 = personFootprint(chart, "p2");
    expect([...p2.functions]).toEqual(["f1"]);
    expect([...p2.posts]).toEqual(["s1"]);
    expect([...p2.touched]).toEqual(["d21", "d20"]);
    expect(p2.departments.size + p2.divisions.size).toBe(0);
    const p1 = personFootprint(chart, "p1");
    expect([...p1.divisions]).toEqual(["v7"]);
    expect([...p1.departments]).toEqual(["d21"]);
  });

  it("peopleOnChart: everyone on the chart, most places first", () => {
    expect(peopleOnChart(chart)).toEqual([
      { id: "p1", name: "Нуралы", count: 2 },
      { id: "p2", name: "Элмурат", count: 2 },
    ]);
  });
});
