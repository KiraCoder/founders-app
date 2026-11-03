import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { todayInTimeZone } from "@/lib/dates";
import { periodsInMonth } from "@/server/ai/month-values";
import { composeRequests, orchestrateTick } from "@/server/ai/orchestrator";
import type { LlmGenerateInput, LlmProvider } from "@/server/ai/provider";
import {
  aiDataRequests,
  aiRoleRuns,
  metricDefinitions,
  notificationsOutbox,
  personCompanies,
  salaries,
  tasks,
} from "@/server/db/schema";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { consumeLinkCode, createLinkCode } from "@/server/notifications/linking";
import { planTick } from "@/server/notifications/planner";
import { numbersWaitingSection } from "@/server/notifications/messages";
import type { NeutralMessage, NotificationChannel } from "@/server/notifications/types";
import {
  collectAiRequests,
  createTaskFromFinding,
  getHire,
  getRun,
  hireRole,
  listHires,
  rerunReport,
  runHireNow,
  updateHire,
  type AiRequestItem,
  type HireView,
} from "@/server/services/ai-roles";
import type { ServiceContext } from "@/server/services/context";
import { saveMetricGrid } from "@/server/services/metrics";
import { updateMyPreferences } from "@/server/services/notifications";
import { createTestDb, type TestDb } from "../helpers/db";

const bishkek = (day: string, hm: string) => new Date(`${day}T${hm}:00+06:00`);

let t: TestDb;
let kiwiGoId: string;
interface Sent {
  userId: string;
  message: NeutralMessage;
  day: string;
}
const sent: Sent[] = [];
let currentDay = "";
const channel: NotificationChannel = {
  name: "telegram",
  async send(recipient, message) {
    sent.push({ userId: recipient.userId, message, day: currentDay });
    return { ok: true, providerMessageId: "1" };
  },
};
/** Like Telegram: only founders with a linked chat can be reached (others: not_linked). */
const registry: ChannelRegistry = { get: () => channel, resolve: (r) => (r.telegramChatId ? channel : null) };

async function tick(now: Date, provider?: LlmProvider) {
  currentDay = todayInTimeZone(now, "Asia/Bishkek");
  await planTick(t.handle.db, now);
  await orchestrateTick(t.handle.db, now, { provider });
  await dispatch(t.handle.db, now, { registry, clock: () => now });
}
async function days(from: string, to: string, hms = ["08:30", "12:00"]) {
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    for (const hm of hms) await tick(bishkek(d.toISOString().slice(0, 10), hm));
  }
}
async function link(who: "nuraaly" | "talant", chat: string, now: Date) {
  const { code } = await createLinkCode(t.handle.db, t.userIds[who], now);
  expect((await consumeLinkCode(t.handle.db, code, { chatId: chat, telegramUserId: chat }, now)).ok).toBe(true);
}
const morningOf = (who: "nuraaly" | "talant", day: string) =>
  sent.find((s) => s.userId === t.userIds[who] && s.message.title.startsWith("Good morning") && s.day === day)?.message;
const sectionLines = (m: NeutralMessage | undefined, heading: string) => {
  if (!m) return [];
  const i = m.lines.findIndex((l) => l.text.startsWith(heading));
  if (i < 0) return [];
  const out: string[] = [];
  for (const l of m.lines.slice(i + 1)) {
    if (l.style === "heading") break;
    out.push(l.text);
  }
  return out;
};
const aiLines = (m: NeutralMessage | undefined) => sectionLines(m, "AI roles · numbers needed");

async function metricId(companyId: string, key: string): Promise<string> {
  const [row] = await t.handle.db
    .select({ id: metricDefinitions.id })
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.companyId, companyId), eq(metricDefinitions.key, key)));
  return row!.id;
}

/** Enters a month of Kiwi Go numbers through the Numbers grid service (as Nuraaly). */
async function enterKiwiMonth(ctx: ServiceContext, month: string, v: { revenue: string; orders: string; collected: string; paid: string }, skip: string[] = []) {
  const days = periodsInMonth(month, "day");
  const cells: { metricId: string; period: string; value: string }[] = [];
  if (!skip.includes("revenue")) cells.push({ metricId: await metricId(kiwiGoId, "revenue"), period: month.slice(0, 7), value: v.revenue });
  for (const [key, val] of [["orders_day", v.orders], ["cod_collected", v.collected], ["cod_paid_out", v.paid]] as const) {
    if (skip.includes(key)) continue;
    const id = await metricId(kiwiGoId, key);
    for (const d of days) cells.push({ metricId: id, period: d, value: val });
  }
  const r = await saveMetricGrid(ctx, kiwiGoId, cells);
  expect(r.errors).toEqual([]);
}

const staff = (): ServiceContext => ({ ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, id: crypto.randomUUID(), role: "staff" } });

beforeAll(async () => {
  t = await createTestDb();
  kiwiGoId = t.companyIds["kiwi-go"]!;
  const prefs = { eveningCheckEnabled: false, eveningCheckTime: "19:00", quietStart: "21:00", quietEnd: "08:00", maxOtherPerDay: 3, urgentAtNight: false };
  await updateMyPreferences(t.ctx("nuraaly"), { ...prefs, morningSummaryTime: "08:30" });
  await updateMyPreferences(t.ctx("talant"), { ...prefs, morningSummaryTime: "08:30" });
  await link("nuraaly", "111", bishkek("2026-11-02", "12:00"));
});
afterAll(async () => {
  await t.handle.close();
});

describe("hire / tune / pause (founders only)", () => {
  let hire: HireView;
  it("a founder hires the Financial Analyst for Kiwi Go with the defaults", async () => {
    hire = await hireRole(t.ctx("nuraaly"), { templateKey: "financial-analyst", companyId: kiwiGoId });
    expect(hire).toMatchObject({
      roleName: "Financial Analyst",
      companyName: "Kiwi Go",
      status: "active",
      scheduleLabel: "Monthly on the 10th",
      hiredOn: "2026-11-02",
      recipientNames: ["Nuraaly", "Talant"],
      askNames: ["Nuraaly", "Talant"],
    });
    expect(hire.settings.requiredMetricKeys).toEqual(["revenue", "orders_day", "cod_collected", "cod_paid_out"]);
    expect(hire.settings.thresholds).toEqual({ changePct: 20, riskChangePct: 50 });
  });
  it("staff get nothing; duplicates, coming-soon roles, companies without numbers and non-founder recipients are refused", async () => {
    await expect(listHires(staff())).rejects.toMatchObject({ code: "forbidden" });
    await expect(getHire(staff(), hire.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateHire(staff(), hire.id, { status: "paused" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(hireRole(staff(), { templateKey: "financial-analyst", companyId: t.companyIds["jobutify"]! })).rejects.toMatchObject({ code: "forbidden" });
    await expect(hireRole(t.ctx("talant"), { templateKey: "financial-analyst", companyId: kiwiGoId })).rejects.toMatchObject({ code: "conflict" });
    await expect(hireRole(t.ctx("talant"), { templateKey: "hr", companyId: kiwiGoId })).rejects.toMatchObject({ code: "validation" });
    await expect(hireRole(t.ctx("talant"), { templateKey: "financial-analyst", companyId: t.companyIds["marketing"]! })).rejects.toMatchObject({
      code: "validation",
    });
    const elmurat = t.personIds["elmurat"]!;
    await expect(updateHire(t.ctx("talant"), hire.id, { settings: { recipients: [elmurat] } })).rejects.toMatchObject({ code: "validation" });
    await expect(updateHire(t.ctx("talant"), hire.id, { settings: { askUserIds: [elmurat] } })).rejects.toMatchObject({ code: "validation" });
    await expect(updateHire(t.ctx("talant"), hire.id, { settings: { requiredMetricKeys: ["wb_sales"] } })).rejects.toMatchObject({ code: "validation" });
  });
  it("the other founder can tune it (shared), pause and resume", async () => {
    const tuned = await updateHire(t.ctx("talant"), hire.id, { settings: { schedule: { kind: "monthly", day: 10 }, thresholds: { changePct: 20, riskChangePct: 50 } }, notes: "Watch COD" });
    expect(tuned.notes).toBe("Watch COD");
    expect((await updateHire(t.ctx("talant"), hire.id, { status: "paused" })).status).toBe("paused");
    await expect(runHireNow(t.ctx("talant"), hire.id)).rejects.toMatchObject({ code: "validation" });
    expect((await updateHire(t.ctx("nuraaly"), hire.id, { status: "active" })).status).toBe("active");
    expect((await listHires(t.ctx("talant"), { companyId: kiwiGoId })).map((h) => h.id)).toEqual([hire.id]);
  });
});

describe("run state machine, data requests and chasing", () => {
  it("before the schedule day nothing runs; on the 10th October waits for data and both founders get a request", async () => {
    await days("2026-11-03", "2026-11-09");
    expect(await t.handle.db.select().from(aiRoleRuns)).toHaveLength(0);
    await tick(bishkek("2026-11-10", "08:00"));
    const [run] = await t.handle.db.select().from(aiRoleRuns);
    expect(run).toMatchObject({ period: "2026-10-01", status: "waiting_for_data", trigger: "schedule" });
    expect(run!.missing.map((m) => `${m.label}: ${m.detail}`)).toEqual([
      // A new Financial Analyst accepts month totals (the founders' decision).
      "Orders per day: no values (31 days) — or enter the month total",
      "COD collected: no values (31 days) — or enter the month total",
      "COD paid out: no values (31 days) — or enter the month total",
      "Revenue: no value",
    ]);
    const reqs = await t.handle.db.select().from(aiDataRequests);
    expect(reqs.map((r) => [r.userId, r.roundKey, r.status]).sort()).toEqual(
      [[t.userIds.nuraaly, "2026-10-01", "active"], [t.userIds.talant, "2026-10-01", "active"]].sort(),
    );
  });

  it("ONE grouped line per founder with a deep link; never more than once a day; daily for 7 days, then weekly", async () => {
    await tick(bishkek("2026-11-10", "08:30"));
    await tick(bishkek("2026-11-10", "12:00"));
    expect(aiLines(morningOf("nuraaly", "2026-11-10"))).toEqual([
      "Financial Analyst needs October 2026 numbers for Kiwi Go: Orders per day, COD collected, COD paid out +1 more — enter the October total (or every day) until the data source is connected: /companies/kiwi-go?tab=numbers&g=day",
    ]);
    await days("2026-11-11", "2026-12-01");
    const shownOn = sent.filter((s) => s.userId === t.userIds.nuraaly && aiLines(s.message).length).map((s) => s.day);
    expect(shownOn).toEqual([
      "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16",
      "2026-11-23", "2026-11-30",
    ]);
    // Nothing but summaries was pushed while waiting (no separate chase pushes).
    const pushes = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.kind, "ai_report_ready"));
    expect(pushes).toHaveLength(0);
  });

  it("dedupe with Numbers waiting: a number the analyst asks for is never also listed there", async () => {
    // Revenue had a value for September → October revenue is "late" in Numbers waiting.
    const m = morningOf("nuraaly", "2026-11-16")!; // not a Monday: daily late list
    const waitingText = sectionLines(m, "Numbers waiting").join(" | ");
    expect(waitingText).not.toContain("Revenue");
    // Composition rule, directly: covered metrics leave Numbers waiting, others stay.
    const revenue = await metricId(kiwiGoId, "revenue");
    const sales = await metricId(t.companyIds["alura-brand"]!, "sales");
    const c = composeRequests(
      [{ requestId: "r1", hireId: "h1", roleName: "Financial Analyst", companyName: "Kiwi Go", companySlug: "kiwi-go", months: ["2026-10-01"], dueToday: false, missing: [{ metricId: revenue, key: "revenue", label: "Revenue", granularity: "month" }], waitingOnHolding: [] }],
      [
        { metricId: revenue, companyName: "Kiwi Go", label: "Revenue" },
        { metricId: sales, companyName: "Alura Brand", label: "Sales" },
      ],
      null,
    );
    expect(c.waiting.map((w) => w.label)).toEqual(["Sales"]);
    expect(c.aiLines).toEqual([]); // parked until its next chase day, still not in Numbers waiting
    // Only the months the role asks for are hidden: a daily number late for November days stays
    // in Numbers waiting while the role asks for its October values.
    const orders = await metricId(kiwiGoId, "orders_day");
    const byPeriod = composeRequests(
      [{ requestId: "r1", hireId: "h1", roleName: "Financial Analyst", companyName: "Kiwi Go", companySlug: "kiwi-go", months: ["2026-10-01"], dueToday: true, waitingOnHolding: [], missing: [{ metricId: orders, key: "orders_day", label: "Orders per day", granularity: "day", months: ["2026-10-01"] }] }],
      [
        { metricId: orders, companyName: "Kiwi Go", label: "Orders per day", waitingFor: "2026-11-02" },
        { metricId: orders, companyName: "Kiwi Go", label: "Orders per day (Oct)", waitingFor: "2026-10-15" },
      ],
      null,
    );
    expect(byPeriod.waiting.map((w) => w.label)).toEqual(["Orders per day"]);
  });

  it("connector-only numbers: 'enter by hand or upload until the data source is connected', and not in the Monday data-sources line (whole-app review #8)", () => {
    const item = (missing: AiRequestItem["missing"]): AiRequestItem => ({ requestId: "r1", hireId: "h1", roleName: "Financial Analyst", companyName: "Kiwi Go", companySlug: "kiwi-go", months: ["2026-10-01"], dueToday: true, waitingOnHolding: [], missing });
    const orders = { metricId: "m-orders", key: "orders_day", label: "Orders per day", granularity: "day" as const, months: ["2026-10-01"], awaitingSource: "Edil's APIs" };
    const revenue = { metricId: "m-rev", key: "revenue", label: "Revenue", granularity: "month" as const, months: ["2026-10-01"], awaitingSource: null };
    const waiting = [
      // Waiting for a November day (another month than the request) — still left out.
      { metricId: "m-orders", companyName: "Kiwi Go", label: "Orders per day", hasData: false, awaitingSource: "Edil's APIs", waitingFor: "2026-11-15" },
      { metricId: "m-wms", companyName: "Jobutify", label: "WMS orders processed", hasData: false, awaitingSource: "Edil's APIs", waitingFor: "2026-11-15" },
    ];
    const only = composeRequests([item([orders])], waiting, null);
    expect(only.aiLines[1]!.text).toBe("Financial Analyst needs October 2026 numbers for Kiwi Go: Orders per day — enter by hand or upload until the data source is connected: /companies/kiwi-go?tab=numbers&g=day");
    expect(only.waiting.map((w) => w.label)).toEqual(["WMS orders processed"]);
    const lines = numbersWaitingSection(only.waiting, "2026-11-16"); // a Monday
    expect(lines.map((l) => l.text)).toContain("1 number waits for data sources (Edil's APIs)");
    const mixed = composeRequests([item([revenue, orders])], waiting, null);
    expect(mixed.aiLines[1]!.text).toContain("Revenue, Orders per day — enter them (the data-source ones by hand or upload until it is connected): ");
    expect(composeRequests([item([revenue])], [], null).aiLines[1]!.text).toContain("Revenue — enter them: ");
  });

  it("dedupe with Holding: the debt number derived from акты is asked by the Holding section only", () => {
    const holding = { lines: [{ text: "Holding · акты", style: "heading" as const }, { text: "Ask Elmurat for 1 missing акт: …", style: "item" as const }], actions: [], itemIds: ["a1"] };
    const item = {
      requestId: "r2",
      hireId: "h2",
      roleName: "Financial Analyst",
      companyName: "Asqa Zou Holding",
      companySlug: "asqa-zou-holding",
      months: ["2026-10-01"],
      dueToday: true,
      missing: [],
      waitingOnHolding: [{ metricId: "m-debt", key: "intercompany_debt", label: "Intercompany debt total" }],
    };
    const c = composeRequests([item], [{ metricId: "m-debt", companyName: "Asqa Zou Holding", label: "Intercompany debt total" }], holding);
    expect(c.aiLines).toEqual([]);
    expect(c.aiRequestIds).toEqual([]);
    expect(c.waiting).toEqual([]);
    expect(c.holding!.lines.at(-1)!.text).toBe("The Financial Analyst (Asqa Zou Holding) is waiting for these акты too (intercompany debt).");
    // The day after "I asked Elmurat" the Holding section has nothing to ask: the analyst
    // still never asks the founders to enter the derived number itself.
    const asked = composeRequests([item], [], null);
    expect(asked.aiLines).toEqual([]);
    expect(composeRequests([item], [], { ...holding, lines: [] }).aiLines).toEqual([]);
    // Even if the debt slipped into `missing`, it is dropped from the line.
    const slipped = { ...item, waitingOnHolding: [], missing: [{ metricId: "m-debt", key: "intercompany_debt", label: "Intercompany debt total", granularity: "month" as const }] };
    expect(composeRequests([slipped], [], null).aiLines).toEqual([]);
  });

  it("a Holding hire waiting only for the debt number: the request lists it as waiting on the Holding, never as a number to enter", async () => {
    const th = await createTestDb();
    try {
      const holdingId = th.companyIds["asqa-zou-holding"]!;
      const hire = await hireRole(th.ctx("nuraaly"), { templateKey: "financial-analyst", companyId: holdingId });
      expect(hire.settings.requiredMetricKeys).toEqual(["intercompany_debt"]);
      await orchestrateTick(th.handle.db, bishkek("2026-11-10", "08:00"));
      const items = await collectAiRequests(th.ctx("nuraaly", bishkek("2026-11-11", "08:30")));
      expect(items).toHaveLength(1);
      expect(items[0]!.missing).toEqual([]);
      expect(items[0]!.waitingOnHolding.map((m) => m.label)).toEqual(["Intercompany debt total"]);
      expect(composeRequests(items, [], null).aiLines).toEqual([]);
      const [run] = await th.handle.db.select().from(aiRoleRuns);
      expect((await getRun(th.ctx("nuraaly"), run!.id)).missingFromHolding).toEqual([run!.missing[0]!.metricId]);
    } finally {
      await th.handle.close();
    }
  });

  it("pause closes the requests; resume (or asking a founder again) revives this month's request with its original cadence", async () => {
    const [hire] = await listHires(t.ctx("nuraaly"));
    const all = async () => (await t.handle.db.select().from(aiDataRequests)).filter((r) => r.roundKey === "2026-10-01");
    const before = (await all()).map((r) => [r.userId, r.createdOn, r.lastShownOn]).sort();
    expect(before.every(([, created]) => created === "2026-11-10")).toBe(true);
    await updateHire(t.ctx("nuraaly", bishkek("2026-12-01", "13:00")), hire!.id, { status: "paused" });
    expect((await all()).filter((r) => r.status === "active")).toHaveLength(0);
    await updateHire(t.ctx("nuraaly", bishkek("2026-12-01", "13:05")), hire!.id, { status: "active" });
    await orchestrateTick(t.handle.db, bishkek("2026-12-01", "13:10"));
    const after = await all();
    expect(after.every((r) => r.status === "active")).toBe(true);
    expect(after.map((r) => [r.userId, r.createdOn, r.lastShownOn]).sort()).toEqual(before);
    // Toggling Talant out of "asks" and back in: same request, same cadence (weekly by now).
    const both = hire!.settings.askUserIds;
    await updateHire(t.ctx("nuraaly", bishkek("2026-12-01", "13:20")), hire!.id, { settings: { askUserIds: [t.userIds.nuraaly] } });
    expect((await all()).find((r) => r.userId === t.userIds.talant)).toMatchObject({ status: "cancelled", reason: "not_asked" });
    await updateHire(t.ctx("nuraaly", bishkek("2026-12-01", "13:25")), hire!.id, { settings: { askUserIds: both } });
    expect((await all()).map((r) => [r.userId, r.status, r.createdOn, r.lastShownOn]).sort()).toEqual(before.map(([u, c, l]) => [u, "active", c, l]).sort());
    // Nuraaly was last chased on 30 Nov (weekly phase): not due again on 2 Dec (a fresh
    // cadence would have chased him daily for another week).
    expect((await collectAiRequests(t.ctx("nuraaly", bishkek("2026-12-02", "08:00"))))[0]!.dueToday).toBe(false);
  });

  it("superseded rounds: Talant (not linked) gets ONE line covering October and November when he links", async () => {
    await days("2026-12-02", "2026-12-10", ["08:30"]);
    const talant = (await t.handle.db.select().from(aiDataRequests)).filter((r) => r.userId === t.userIds.talant);
    expect(talant.filter((r) => r.status === "active").map((r) => r.roundKey)).toEqual(["2026-11-01"]);
    expect(talant.find((r) => r.roundKey === "2026-10-01")).toMatchObject({ status: "cancelled", reason: "superseded" });
    await link("talant", "222", bishkek("2026-12-11", "07:00"));
    await tick(bishkek("2026-12-11", "08:30"));
    expect(aiLines(morningOf("talant", "2026-12-11"))).toEqual([
      "Financial Analyst needs October and November 2026 numbers for Kiwi Go: Orders per day, COD collected, COD paid out +1 more — enter the October and November 2026 totals (or every day) until the data source is connected: /companies/kiwi-go?tab=numbers&g=day",
    ]);
  });
});

describe("analysis and the report-ready push", () => {
  it("numbers in → ready → analysed → reported; ONE push per founder per run; NoneProvider skips the narrative", async () => {
    const at = bishkek("2026-12-12", "08:00");
    const ctx = t.ctx("nuraaly", at);
    await enterKiwiMonth(ctx, "2026-08-01", { revenue: "1000000", orders: "100", collected: "30000", paid: "30000" });
    await enterKiwiMonth(ctx, "2026-09-01", { revenue: "1200000", orders: "100", collected: "30000", paid: "29000" });
    await enterKiwiMonth(ctx, "2026-10-01", { revenue: "810000", orders: "100", collected: "30000", paid: "10000" });
    await tick(bishkek("2026-12-12", "08:30"));
    const [oct] = await t.handle.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.period, "2026-10-01"));
    expect(oct).toMatchObject({ status: "reported", narrativeStatus: "narrative_skipped", provider: "none", narrative: null });
    const view = await getRun(t.ctx("talant", at), oct!.id);
    expect(view.findings.map((f) => `${f.severity}:${f.rule}`)).toEqual(["risk:cod_payout", "warn:change", "warn:ratio", "info:change", "info:never_entered"]);
    expect(view.findings[0]!.sentence).toBe(
      "Only 33.3% of COD collected in October was paid out to shops: 930 000 KGS collected, 310 000 KGS paid out (620 000 KGS not paid out yet).",
    );
    expect(view.inputs!.months).toEqual(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(view.inputs!.metrics.find((m) => m.key === "revenue")!.values).toEqual([null, "1000000", "1200000", "810000"]);
    // "Numbers used" labels month values as what they are (31 daily values summed).
    expect(view.inputs!.metrics.map((m) => m.label)).toContain("Orders (month total)");
    expect(view.inputs!.metrics.map((m) => m.label)).not.toContain("Orders per day");
    expect(view.inputs!.metrics.find((m) => m.key === "orders_day")!.values.at(-1)).toBe("3100");
    expect(view.inputs!.metrics.find((m) => m.key === "on_time_pct")!.label).toBe("Average on-time delivery");
    // November still waits: Talant's request now asks only for November.
    const nov = (await t.handle.db.select().from(aiRoleRuns)).find((r) => r.period === "2026-11-01");
    expect(nov?.status).toBe("waiting_for_data");

    const pushes = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.kind, "ai_report_ready"));
    expect(pushes.map((p) => p.userId).sort()).toEqual([t.userIds.nuraaly, t.userIds.talant].sort());
    expect(pushes.every((p) => p.status === "sent")).toBe(true);
    const msg = sent.find((s) => s.message.title === "Financial Analyst: report ready" && s.userId === t.userIds.nuraaly)!.message;
    expect(msg.lines[0]!.text).toBe("Kiwi Go · October 2026");
    expect(msg.lines.at(-1)!.text).toBe(`Open the report: /ai-roles/runs/${oct!.id}`);

    // More ticks, "Run now", a re-run with unchanged numbers: never a second push.
    await days("2026-12-12", "2026-12-13");
    await runHireNow(t.ctx("nuraaly", bishkek("2026-11-20", "10:00")), oct!.hireId); // last month = October
    expect(await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.kind, "ai_report_ready"))).toHaveLength(2);
  });

  it("a corrected number: the report says so; Run again re-analyses it without another push", async () => {
    const [oct] = await t.handle.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.period, "2026-10-01"));
    const ctx = t.ctx("nuraaly", bishkek("2026-12-14", "10:00"));
    expect((await getRun(ctx, oct!.id)).inputsChanged).toBe(false);
    await saveMetricGrid(ctx, kiwiGoId, [{ metricId: await metricId(kiwiGoId, "revenue"), period: "2026-10", value: "1150000" }]);
    await tick(bishkek("2026-12-14", "10:30"));
    // A tick never silently changes a report the founders already got.
    const before = await getRun(ctx, oct!.id);
    expect(before.inputsChanged).toBe(true);
    expect(before.findings.some((f) => f.rule === "change" && f.metricKeys[0] === "revenue")).toBe(true);
    const after = await rerunReport(ctx, oct!.id);
    expect(after.inputsChanged).toBe(false);
    expect(after.status).toBe("reported");
    expect(after.findings.some((f) => f.rule === "change" && f.metricKeys[0] === "revenue")).toBe(false);
    expect(after.analysedAt).not.toBe(before.analysedAt);
    expect(await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.kind, "ai_report_ready"))).toHaveLength(2);
  });

  it("Create task from a risk finding: only on request, once, shared for the company", async () => {
    const [oct] = await t.handle.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.period, "2026-10-01"));
    expect((await t.handle.db.select().from(tasks)).filter((x) => x.title.startsWith("Financial Analyst"))).toHaveLength(0);
    const view = await getRun(t.ctx("talant"), oct!.id);
    const risk = view.findings.find((f) => f.severity === "risk")!;
    const info = view.findings.find((f) => f.severity === "info")!;
    await expect(createTaskFromFinding(t.ctx("talant"), oct!.id, info.id)).rejects.toMatchObject({ code: "validation" });
    await expect(createTaskFromFinding(staff(), oct!.id, risk.id)).rejects.toMatchObject({ code: "forbidden" });
    const [a, b] = await Promise.all([createTaskFromFinding(t.ctx("talant"), oct!.id, risk.id), createTaskFromFinding(t.ctx("nuraaly"), oct!.id, risk.id)]);
    expect(a.taskId).toBe(b.taskId);
    const made = (await t.handle.db.select().from(tasks)).filter((x) => x.title.startsWith("Financial Analyst"));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ visibility: "shared", companyId: kiwiGoId, priority: "high" });
    expect((await getRun(t.ctx("nuraaly"), oct!.id)).findings.find((f) => f.id === risk.id)!.taskId).toBe(a.taskId);
  });

  it("a Tune after the report says 'Settings changed' (not 'Numbers changed'); Run again keeps the task link", async () => {
    const [oct] = await t.handle.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.period, "2026-10-01"));
    const ctx = t.ctx("talant", bishkek("2026-12-15", "10:00"));
    const before = await getRun(ctx, oct!.id);
    expect(before).toMatchObject({ inputsChanged: false, settingsChanged: false });
    const linked = before.findings.find((f) => f.taskId)!;
    await updateHire(ctx, oct!.hireId, { settings: { thresholds: { changePct: 25, riskChangePct: 60 } } });
    const tuned = await getRun(ctx, oct!.id);
    expect(tuned).toMatchObject({ inputsChanged: false, settingsChanged: true });
    const after = await rerunReport(ctx, oct!.id);
    expect(after).toMatchObject({ inputsChanged: false, settingsChanged: false, status: "reported" });
    expect(after.findings.find((f) => f.id === linked.id)!.taskId).toBe(linked.taskId);
    await updateHire(ctx, oct!.hireId, { settings: { thresholds: { changePct: 20, riskChangePct: 50 } } });
    await rerunReport(ctx, oct!.id);
    // A report from before 0013 (one combined hash, no settings hash) still compares as before.
    await t.handle.db.update(aiRoleRuns).set({ settingsHash: null, inputsHash: "old-combined-hash" }).where(eq(aiRoleRuns.id, oct!.id));
    expect(await getRun(ctx, oct!.id)).toMatchObject({ inputsChanged: true, settingsChanged: false });
    await rerunReport(ctx, oct!.id);
    expect(await getRun(ctx, oct!.id)).toMatchObject({ inputsChanged: false, settingsChanged: false });
  });

  it("a task created while the run is re-analysing keeps its link (no duplicate task on the next click)", async () => {
    const [oct] = await t.handle.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.period, "2026-10-01"));
    // Start from a risk finding without a task.
    const unlinked = (oct!.findings as { id: string; taskId?: string | null }[]).map((f) => ({ ...f, taskId: null }));
    await t.handle.db.update(aiRoleRuns).set({ findings: unlinked }).where(eq(aiRoleRuns.id, oct!.id));
    const risk = (await getRun(t.ctx("nuraaly"), oct!.id)).findings.find((f) => f.severity === "risk")!;
    const ctx = t.ctx("nuraaly", bishkek("2026-12-16", "10:00"));
    await saveMetricGrid(ctx, kiwiGoId, [{ metricId: await metricId(kiwiGoId, "revenue"), period: "2026-10", value: "1160000" }]);
    let raced: string | null = null;
    // The provider runs between the analysis and the write: a founder clicks "Create task" then.
    const racing: LlmProvider = {
      id: "race",
      configured: true,
      generate: async () => {
        raced = (await createTaskFromFinding(t.ctx("talant"), oct!.id, risk.id)).taskId;
        return { text: "ok", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const after = await rerunReport(ctx, oct!.id, { provider: racing });
    expect(raced).not.toBeNull();
    expect(after.findings.find((f) => f.id === risk.id)!.taskId).toBe(raced);
    expect(await createTaskFromFinding(t.ctx("nuraaly"), oct!.id, risk.id)).toEqual({ taskId: raced, created: false });
  });
});

describe("report-ready push respects budget, quiet hours and not linked", () => {
  let tt: TestDb;
  const out: Sent[] = [];
  const ch: NotificationChannel = { name: "telegram", send: async (r, message) => (out.push({ userId: r.userId, message, day: "" }), { ok: true }) };
  const reg: ChannelRegistry = { get: () => ch, resolve: (r) => (r.telegramChatId ? ch : null) };
  beforeAll(async () => {
    tt = await createTestDb();
    const prefs = { eveningCheckEnabled: false, eveningCheckTime: "19:00", quietStart: "21:00", quietEnd: "08:00", urgentAtNight: false, morningSummaryTime: "08:30" };
    await updateMyPreferences(tt.ctx("nuraaly"), { ...prefs, maxOtherPerDay: 0 });
    await updateMyPreferences(tt.ctx("talant"), { ...prefs, maxOtherPerDay: 3 });
    const { code } = await createLinkCode(tt.handle.db, tt.userIds.nuraaly, FIXED);
    await consumeLinkCode(tt.handle.db, code, { chatId: "1", telegramUserId: "1" }, FIXED);
  });
  afterAll(async () => {
    await tt.handle.close();
  });
  const FIXED = bishkek("2026-11-02", "12:00");

  it("budget 0 → parked and listed in the next morning summary; quiet hours hold; not linked waits", async () => {
    const hire = await hireRole(tt.ctx("nuraaly"), {
      templateKey: "financial-analyst",
      companyId: tt.companyIds["alura-brand"]!,
    });
    const ctx = tt.ctx("nuraaly", bishkek("2026-11-02", "22:00"));
    const sales = (await tt.handle.db.select().from(metricDefinitions).where(eq(metricDefinitions.companyId, tt.companyIds["alura-brand"]!)));
    await saveMetricGrid(ctx, tt.companyIds["alura-brand"]!, sales.map((d) => ({ metricId: d.id, period: "2026-10", value: "100" })));
    // 22:00 (quiet hours): the run is reported and the pushes queued, nothing sent yet.
    await runHireNow(ctx, hire.id);
    await dispatch(tt.handle.db, bishkek("2026-11-02", "22:00"), { registry: reg, clock: () => new Date() });
    expect(out).toHaveLength(0);
    const rows = async () => (await tt.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.kind, "ai_report_ready")));
    expect((await rows()).map((r) => r.status).sort()).toEqual(["not_linked", "pending"]);
    // 08:10 next day: Nuraaly's budget is 0 → parked (not sent); Talant still not linked.
    await dispatch(tt.handle.db, bishkek("2026-11-03", "08:10"), { registry: reg, clock: () => new Date() });
    const r1 = await rows();
    expect(r1.find((r) => r.userId === tt.userIds.nuraaly)!.status).toBe("parked");
    expect(r1.find((r) => r.userId === tt.userIds.talant)!.status).toBe("not_linked");
    // Morning summary lists the parked report.
    await planTick(tt.handle.db, bishkek("2026-11-03", "08:30"));
    await dispatch(tt.handle.db, bishkek("2026-11-03", "08:30"), { registry: reg, clock: () => new Date() });
    const morning = out.find((s) => s.message.title.startsWith("Good morning"))!.message;
    expect(sectionLines(morning, "Parked reminders")).toEqual([expect.stringMatching(/^Report ready: Financial Analyst · Alura Brand · October 2026 \(No findings\) — \/ai-roles\/runs\/[0-9a-f-]+$/)]);
    // Talant links: his push goes out once.
    const { code } = await createLinkCode(tt.handle.db, tt.userIds.talant, bishkek("2026-11-03", "09:00"));
    await consumeLinkCode(tt.handle.db, code, { chatId: "2", telegramUserId: "2" }, bishkek("2026-11-03", "09:00"));
    await dispatch(tt.handle.db, bishkek("2026-11-03", "09:05"), { registry: reg, clock: () => new Date() });
    await dispatch(tt.handle.db, bishkek("2026-11-03", "09:35"), { registry: reg, clock: () => new Date() });
    // His morning summary (held until he linked) goes out in the same run, so the report is
    // folded into it instead of arriving as a second message (whole-app review #7).
    expect(out.filter((s) => s.userId === tt.userIds.talant).map((s) => s.message.title)).toEqual(["Good morning, Talant"]);
    expect(sectionLines(out.find((s) => s.userId === tt.userIds.talant)!.message, "Parked reminders")).toEqual([expect.stringMatching(/^Report ready: Financial Analyst/)]);
    // Later the same day (no summary waiting) a report push goes out on its own as before.
    await tt.handle.db.update(notificationsOutbox).set({ status: "pending", bundledIntoId: null, parkedAt: null, lastError: null, sentAt: null }).where(and(eq(notificationsOutbox.userId, tt.userIds.talant), eq(notificationsOutbox.kind, "ai_report_ready")));
    await dispatch(tt.handle.db, bishkek("2026-11-03", "11:00"), { registry: reg, clock: () => new Date() });
    expect(out.filter((s) => s.userId === tt.userIds.talant && s.message.title === "Financial Analyst: report ready")).toHaveLength(1);
    expect(out.filter((s) => s.userId === tt.userIds.nuraaly && s.message.title === "Financial Analyst: report ready")).toHaveLength(0);
  });

  it("a crash marks the run failed; retries back off (1 h, 6 h, 24 h), stop after 5 tries until Retry; a later failure keeps the report", async () => {
    const hire = await hireRole(tt.ctx("talant"), { templateKey: "financial-analyst", companyId: tt.companyIds["upsell-group"]! });
    const ctx = tt.ctx("talant", bishkek("2026-11-04", "12:00"));
    const defs = await tt.handle.db.select().from(metricDefinitions).where(eq(metricDefinitions.companyId, tt.companyIds["upsell-group"]!));
    const cells = defs.flatMap((d) => periodsInMonth("2026-10-01", "day").map((p) => ({ metricId: d.id, period: p, value: "5" })));
    await saveMetricGrid(ctx, tt.companyIds["upsell-group"]!, cells);
    const crash = { analyse: () => { throw new Error("rules crashed"); } };
    const run = await runHireNow(ctx, hire.id, crash);
    expect(run).toMatchObject({ status: "failed", error: "rules crashed", attempts: 1, gaveUp: false, nextAttemptAt: bishkek("2026-11-04", "13:00").toISOString() });
    const state = async () => {
      const [r] = await tt.handle.db.select().from(aiRoleRuns).where(eq(aiRoleRuns.id, run.id));
      return { status: r!.status, attempts: r!.attempts, next: r!.nextAttemptAt?.toISOString() ?? null };
    };
    // Not retried every tick: only once its backoff is over.
    await orchestrateTick(tt.handle.db, bishkek("2026-11-04", "12:10"), crash);
    await orchestrateTick(tt.handle.db, bishkek("2026-11-04", "12:50"), crash);
    expect(await state()).toEqual({ status: "failed", attempts: 1, next: bishkek("2026-11-04", "13:00").toISOString() });
    await orchestrateTick(tt.handle.db, bishkek("2026-11-04", "13:00"), crash);
    expect(await state()).toEqual({ status: "failed", attempts: 2, next: bishkek("2026-11-04", "19:00").toISOString() });
    await orchestrateTick(tt.handle.db, bishkek("2026-11-04", "19:05"), crash);
    expect(await state()).toEqual({ status: "failed", attempts: 3, next: bishkek("2026-11-05", "19:05").toISOString() });
    await orchestrateTick(tt.handle.db, bishkek("2026-11-05", "19:10"), crash);
    await orchestrateTick(tt.handle.db, bishkek("2026-11-06", "19:15"), crash);
    expect(await state()).toEqual({ status: "failed", attempts: 5, next: null });
    // Gave up: no more automatic tries (even without the crash), visible on the page.
    await orchestrateTick(tt.handle.db, bishkek("2026-11-09", "12:00"));
    const gaveUp = await getRun(ctx, run.id);
    expect(gaveUp).toMatchObject({ status: "failed", attempts: 5, gaveUp: true, nextAttemptAt: null });
    expect(gaveUp.summary).toBe("Failed 5 times — stopped retrying; Retry on the report");
    // Retry (a founder) runs it now.
    const retried = await rerunReport(tt.ctx("talant", bishkek("2026-11-09", "12:05")), run.id);
    expect(retried).toMatchObject({ status: "reported", attempts: 0, gaveUp: false, error: null });
    // A later re-analysis that fails keeps the last good report.
    await saveMetricGrid(ctx, tt.companyIds["upsell-group"]!, [{ metricId: defs[0]!.id, period: "2026-10-01", value: "6" }]);
    const failedAgain = await rerunReport(tt.ctx("talant", bishkek("2026-11-09", "12:10")), run.id, crash);
    expect(failedAgain).toMatchObject({ status: "reported", error: "rules crashed", attempts: 1, reportedAt: retried.reportedAt, findings: retried.findings });
  });

  it("salary data never reaches the provider's prompt (a configured test-double provider captures it)", async () => {
    const [link] = await tt.handle.db.select().from(personCompanies).where(eq(personCompanies.companyId, tt.companyIds["jobutify"]!));
    await tt.handle.db.insert(salaries).values({ personCompanyId: link!.id, amount: "45678.91", effectiveFrom: "2026-01-01" });
    const prompts: LlmGenerateInput[] = [];
    const capture: LlmProvider = { id: "capture", configured: true, generate: async (i) => (prompts.push(i), { text: "ok", usage: { inputTokens: 0, outputTokens: 0 } }) };
    const hire = await hireRole(tt.ctx("talant"), { templateKey: "financial-analyst", companyId: tt.companyIds["jobutify"]! });
    const ctx = tt.ctx("talant", bishkek("2026-11-05", "12:00"));
    const defs = await tt.handle.db.select().from(metricDefinitions).where(eq(metricDefinitions.companyId, tt.companyIds["jobutify"]!));
    await saveMetricGrid(ctx, tt.companyIds["jobutify"]!, defs.flatMap((d) => periodsInMonth("2026-10-01", "day").map((p) => ({ metricId: d.id, period: p, value: "7" }))));
    const run = await runHireNow(ctx, hire.id, { provider: capture });
    expect(run).toMatchObject({ status: "reported", narrativeStatus: "narrative_done", narrative: "ok", provider: "capture" });
    const text = JSON.stringify(prompts);
    expect(prompts).toHaveLength(1);
    expect(text).not.toMatch(/45\s?678|45678|оклад|salary/i);
    expect(text).toContain("Jobutify");
  });
});

describe("pay-named numbers never break a report", () => {
  it("'Payroll fund': reported without a provider; with one, its finding is left out of the prompt", async () => {
    const tp = await createTestDb();
    try {
      const kg = tp.companyIds["kiwi-go"]!;
      const [def] = await tp.handle.db
        .insert(metricDefinitions)
        .values({ companyId: kg, key: "payroll_fund", name: "Payroll fund", unit: "KGS", granularity: "month", aggregation: "last", direction: "lower_is_better" })
        .returning();
      const hire = await hireRole(tp.ctx("nuraaly"), { templateKey: "financial-analyst", companyId: kg, settings: { requiredMetricKeys: ["payroll_fund"] } });
      const ctx = tp.ctx("nuraaly", bishkek("2026-11-06", "12:00"));
      await saveMetricGrid(ctx, kg, [
        { metricId: def!.id, period: "2026-09", value: "900000" },
        { metricId: def!.id, period: "2026-10", value: "1200000" },
      ]);
      const run = await runHireNow(ctx, hire.id);
      expect(run).toMatchObject({ status: "reported", narrativeStatus: "narrative_skipped", error: null });
      expect(run.findings.some((f) => f.metricKeys.includes("payroll_fund"))).toBe(true);

      const prompts: LlmGenerateInput[] = [];
      const capture: LlmProvider = { id: "capture", configured: true, generate: async (i) => (prompts.push(i), { text: "ok", usage: { inputTokens: 0, outputTokens: 0 } }) };
      await saveMetricGrid(ctx, kg, [{ metricId: def!.id, period: "2026-10", value: "1300000" }]);
      const again = await rerunReport(ctx, run.id, { provider: capture });
      expect(again).toMatchObject({ status: "reported", narrativeStatus: "narrative_done", narrativeOmitted: 1 });
      expect(prompts).toHaveLength(1);
      expect(JSON.stringify(prompts)).not.toMatch(/payroll|1 300 000/i);
    } finally {
      await tp.handle.close();
    }
  });
});

describe("ai_role tables", () => {
  it("runs are unique per hire and month; requests per hire, founder and round", async () => {
    const [run] = await t.handle.db.select().from(aiRoleRuns);
    await expect(t.handle.db.insert(aiRoleRuns).values({ hireId: run!.hireId, period: run!.period })).rejects.toThrow();
    await expect(t.handle.db.insert(aiRoleRuns).values({ hireId: run!.hireId, period: "2026-10-15" })).rejects.toThrow();
  });
});
