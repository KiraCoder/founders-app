import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { todayInTimeZone } from "@/lib/dates";
import { ORG_STRUCTURE_EXPERT } from "@/lib/ai-roles";
import { orchestrateTick } from "@/server/ai/orchestrator";
import { aiRoleRuns, metricDefinitions } from "@/server/db/schema";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { consumeLinkCode, createLinkCode } from "@/server/notifications/linking";
import { planTick } from "@/server/notifications/planner";
import type { NeutralMessage, NotificationChannel } from "@/server/notifications/types";
import { hireRole, runHireNow, updateHire } from "@/server/services/ai-roles";
import { buildMetricCards, listMetricDefinitions } from "@/server/services/metrics";
import { applyVysotskyTemplate, getOrgChart, orgExpertForCompany, orgPeopleOptions, updateDepartment } from "@/server/services/org";
import { createTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "../helpers/db";

const bishkek = (day: string, hm: string) => new Date(`${day}T${hm}:00+06:00`);

let t: TestDb;
const sent: { userId: string; message: NeutralMessage; day: string }[] = [];
let currentDay = "";
const channel: NotificationChannel = {
  name: "telegram",
  async send(recipient, message) {
    sent.push({ userId: recipient.userId, message, day: currentDay });
    return { ok: true, providerMessageId: "1" };
  },
};
const registry: ChannelRegistry = { get: () => channel, resolve: (r) => (r.telegramChatId ? channel : null) };

async function tick(now: Date) {
  currentDay = todayInTimeZone(now, "Asia/Bishkek");
  await planTick(t.handle.db, now);
  await orchestrateTick(t.handle.db, now);
  await dispatch(t.handle.db, now, { registry, clock: () => now });
}
const orgLines = (m: NeutralMessage | undefined) => (m?.lines ?? []).filter((l) => l.text.startsWith("Org Structure Expert"));
const morningOf = (who: "nuraaly" | "talant", day: string) =>
  sent.find((s) => s.userId === t.userIds[who] && s.message.title.startsWith("Good morning") && s.day === day)?.message;

beforeAll(async () => {
  t = await createTestDb({ now: bishkek("2026-11-01", "12:00") });
  for (const [who, chat] of [["nuraaly", "101"], ["talant", "202"]] as const) {
    const { code } = await createLinkCode(t.handle.db, t.userIds[who], bishkek("2026-11-01", "12:00"));
    expect((await consumeLinkCode(t.handle.db, code, { chatId: chat, telegramUserId: chat }, bishkek("2026-11-01", "12:00"))).ok).toBe(true);
  }
});
afterAll(async () => {
  await t.handle.close();
});

describe("Org Structure Expert", () => {
  it("findings on Kiwi Go's chart: stale linked number, 5+ overdue tasks, overloaded head", async () => {
    const ctx = t.ctx("nuraaly", bishkek("2026-11-01", "12:00"));
    const kiwi = t.companyIds["kiwi-go"]!;
    const chart = (await getOrgChart(ctx, { companyId: kiwi, companyUnitId: null }))!;
    const depts = chart.divisions.flatMap((d) => d.departments);
    const d = (n: number) => depts.find((x) => x.number === n)!;
    const [revenue] = await t.handle.db.select().from(metricDefinitions).where(eq(metricDefinitions.companyId, kiwi)).limit(1);
    await updateDepartment(ctx, d(7).id, { metricDefinitionId: revenue!.id }); // no values → not up to date
    for (const n of [1, 2, 3, 4, 5]) await updateDepartment(ctx, d(n).id, { headPersonId: t.personIds["elmurat"]! });
    for (let i = 0; i < 5; i++) await createTask(ctx, { title: `Просрочено ${i}`, companyId: kiwi, orgDepartmentId: d(8).id, dueDate: "2026-10-20" });

    const [res] = await orgExpertForCompany(ctx, kiwi);
    const byRule = Object.fromEntries(res!.findings.map((f) => [f.rule, f]));
    expect(byRule.head_overloaded).toMatchObject({ severity: "warning", text: "Elmurat (5) heads more than 4 departments" });
    expect(byRule.metric_stale!.items[0]).toMatch(/^7 Доходы и COD · /);
    expect(byRule.overdue_tasks).toMatchObject({ count: 1, items: ["8 Расходы и выплаты (5)"] });
    expect(byRule.department_no_head!.count).toBe(16);
    expect(byRule.department_no_ckp!.count).toBe(9);
    expect(byRule.function_no_responsible).toMatchObject({ severity: "info", count: 43 });
    // Tuned limit: 5 departments are fine with a limit of 5.
    const [tuned] = await orgExpertForCompany(ctx, kiwi, { maxDepartmentsPerHead: 5 });
    expect(tuned!.findings.some((f) => f.rule === "head_overloaded")).toBe(false);

    // The org board hands over what it already loaded (archived rows included): same findings.
    const board = (await getOrgChart(ctx, { companyId: kiwi, companyUnitId: null }, { includeArchived: true }))!;
    const metricDefs = await listMetricDefinitions(ctx, kiwi);
    const linked = metricDefs.filter((m) => board.divisions.flatMap((x) => [...x.departments, ...x.archivedDepartments]).some((x) => x.metricDefinitionId === m.id));
    const cards = new Map((await buildMetricCards(ctx, linked)).map((c) => [c.id, c]));
    const [pre] = await orgExpertForCompany(ctx, kiwi, {}, {
      company: { slug: "kiwi-go", name: "Kiwi Go" },
      metricDefs,
      people: await orgPeopleOptions(ctx, kiwi),
      views: new Map([[board.id, board]]),
      cards,
      onlyChartId: board.id,
    });
    expect(pre).toEqual(res);
  });

  it("is hireable without numbers; has no monthly runs and no Run now", async () => {
    const ctx = t.ctx("nuraaly", bishkek("2026-11-01", "12:00"));
    await applyVysotskyTemplate(ctx, { companyId: t.companyIds["jobutify"]!, companyUnitId: null });
    const kiwiHire = await hireRole(ctx, { templateKey: ORG_STRUCTURE_EXPERT, companyId: t.companyIds["kiwi-go"]!, settings: { recipients: [t.userIds.nuraaly] } });
    expect(kiwiHire).toMatchObject({ roleName: "Org Structure Expert", scheduleLabel: "Weekly on Mondays", status: "active" });
    expect(kiwiHire.settings).toMatchObject({ requiredMetricKeys: [], recipients: [t.userIds.nuraaly], askUserIds: [t.userIds.nuraaly] });
    // Marketing has no numbers at all — still hireable (it checks the chart, not numbers).
    await hireRole(ctx, { templateKey: ORG_STRUCTURE_EXPERT, companyId: t.companyIds["marketing"]!, settings: { recipients: [t.userIds.nuraaly] } });
    await hireRole(ctx, { templateKey: ORG_STRUCTURE_EXPERT, companyId: t.companyIds["jobutify"]!, settings: { recipients: [t.userIds.nuraaly], maxDepartmentsPerHead: 3 } });
    await expect(hireRole(ctx, { templateKey: ORG_STRUCTURE_EXPERT, companyId: t.companyIds["kiwi-go"]! })).rejects.toMatchObject({ code: "conflict" });
    await expect(runHireNow(ctx, kiwiHire.id)).rejects.toMatchObject({ code: "validation" });
    await orchestrateTick(t.handle.db, bishkek("2026-11-10", "12:00"));
    expect(await t.handle.db.select().from(aiRoleRuns)).toEqual([]);
  });

  it("reports ONE grouped line in Monday's morning summary of its recipients only — not on other days, never a separate push", async () => {
    for (const day of ["2026-11-02", "2026-11-03", "2026-11-04"]) for (const hm of ["08:30", "12:00"]) await tick(bishkek(day, hm));

    const monday = morningOf("nuraaly", "2026-11-02");
    expect(orgLines(monday)).toHaveLength(1);
    const line = orgLines(monday)[0]!.text;
    expect(line).toMatch(/^Org Structure Expert \(weekly\): Kiwi Go: 7 without a head \(divisions\), 16 without a head \+\d more; Jobutify: 7 without a head \(divisions\), 21 without a head \+2 more — /);
    expect(line).not.toMatch(/Marketing/); // no chart: info only, nothing to say in the summary
    expect(line).not.toMatch(/stale/);
    expect(monday!.lines.some((l) => l.text === "AI roles" && l.style === "heading")).toBe(true);

    expect(orgLines(morningOf("nuraaly", "2026-11-03"))).toEqual([]);
    expect(orgLines(morningOf("nuraaly", "2026-11-04"))).toEqual([]);
    expect(orgLines(morningOf("talant", "2026-11-02"))).toEqual([]);
    expect(sent.filter((s) => !s.message.title.startsWith("Good morning") && JSON.stringify(s.message).includes("Org Structure Expert"))).toEqual([]);
  });

  it("a paused expert says nothing; resumed, it is back the next Monday", async () => {
    const ctx = t.ctx("nuraaly", bishkek("2026-11-05", "12:00"));
    const { listHires } = await import("@/server/services/ai-roles");
    const hires = (await listHires(ctx)).filter((h) => h.templateKey === ORG_STRUCTURE_EXPERT);
    for (const h of hires) await updateHire(ctx, h.id, { status: "paused" });
    for (const hm of ["08:30", "12:00"]) await tick(bishkek("2026-11-09", hm));
    expect(morningOf("nuraaly", "2026-11-09")).toBeDefined();
    expect(orgLines(morningOf("nuraaly", "2026-11-09"))).toEqual([]);
    for (const h of hires) await updateHire(ctx, h.id, { status: "active" });
    for (const hm of ["08:30", "12:00"]) await tick(bishkek("2026-11-16", hm));
    expect(orgLines(morningOf("nuraaly", "2026-11-16"))).toHaveLength(1);
  });
});
