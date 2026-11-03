/**
 * "Who to ask" per intercompany flow (the founders' request: not only Elmurat): default =
 * the companies' accountant, a person per flow, an override per ask round, grouping by
 * person in the morning summary (one line per person) and the in-app card, generic wording
 * with nobody named, isolation (the person must work for one of the flow's companies), and
 * still nobody but the two founders ever receives anything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { holdingAskItems, holdingAskOverrides, intercompanyActs, intercompanyFlows, notificationsOutbox, people, personCompanies, users } from "@/server/db/schema";
import { createFlow, getActsGrid, listFlows, setAskOverride, updateFlow, type FlowView } from "@/server/services/holding";
import { askCardFromGrid, holdingSummarySection, markAskedInApp, planHoldingAsks } from "@/server/services/holding-asks";
import { createTestDb, type TestDb } from "../helpers/db";

const bishkek = (day: string, hm: string) => new Date(`${day}T${hm}:00+06:00`);
const TZ = "Asia/Bishkek";

let t: TestDb;
let sew: FlowView; // Alura Style → Alura Brand
let app: FlowView; // Jobutify → Kiwi Go
let aigul: string;
let left: string;

async function addPerson(fullName: string, shortName: string | null, links: { company: string; role: string; active?: boolean }[], opts: { left?: boolean } = {}) {
  const [p] = await t.handle.db
    .insert(people)
    .values({ fullName, shortName, leftAt: opts.left ? new Date("2026-10-01T00:00:00Z") : null })
    .returning({ id: people.id });
  for (const l of links) {
    await t.handle.db.insert(personCompanies).values({ personId: p!.id, companyId: t.companyIds[l.company]!, role: l.role, isActive: l.active ?? true });
  }
  return p!.id;
}

const summaryLines = (s: Awaited<ReturnType<typeof holdingSummarySection>>) => (s?.lines ?? []).filter((l) => l.style === "item").map((l) => l.text);

beforeAll(async () => {
  t = await createTestDb({ now: bishkek("2026-11-01", "12:00") });
  const n = t.ctx("nuraaly", bishkek("2026-11-01", "12:00"));
  const flows = await listFlows(n);
  sew = flows.find((f) => f.label === "Alura Style → Alura Brand")!;
  app = flows.find((f) => f.label === "Jobutify → Kiwi Go")!;
  await updateFlow(n, sew.id, { since: "2026-09-01" });
  await updateFlow(n, app.id, { since: "2026-10-01" });
  aigul = await addPerson("Aigul Asanova", "Айгуль", [{ company: "alura-brand", role: "manager" }]);
  left = await addPerson("Bakyt", null, [{ company: "alura-style", role: "accountant" }], { left: true });
});
afterAll(async () => {
  await t.handle.close();
});

describe("default: the companies' accountant", () => {
  it("seeded flows ask Elmurat (the accountant of both companies); founders and people who left are never options", async () => {
    expect(sew.askPerson).toMatchObject({ id: t.personIds.elmurat, name: "Elmurat", nameRu: "Элмурат" });
    expect(app.askPerson?.id).toBe(t.personIds.elmurat);
    const fresh = (await listFlows(t.ctx("nuraaly"))).find((f) => f.id === sew.id)!;
    const ids = fresh.askOptions.map((o) => o.id);
    expect(ids).toContain(aigul);
    expect(ids).toContain(t.personIds.elmurat);
    expect(ids).not.toContain(left);
    expect(ids).not.toContain(t.personIds.nuraaly);
    expect(ids).not.toContain(t.personIds.talant);
  });

  it("a new flow defaults to the accountant; between companies without one, nobody is named", async () => {
    const n = t.ctx("nuraaly");
    const withAcc = await createFlow(n, { fromCompanyId: t.companyIds["kiwi-go"]!, toCompanyId: t.companyIds["jobutify"]!, service: "доставка документов" });
    expect(withAcc.askPerson?.id).toBe(t.personIds.elmurat);
    const noAcc = await createFlow(n, { fromCompanyId: t.companyIds["upsell-group"]!, toCompanyId: t.companyIds["marketing"]!, service: "реклама", status: "planned" });
    expect(noAcc.askPerson).toBeNull();
    const explicitNone = await createFlow(n, { fromCompanyId: t.companyIds["kiwi-go"]!, toCompanyId: t.companyIds["alura-style"]!, service: "курьер", askPersonId: null });
    expect(explicitNone.askPerson).toBeNull();
  });
});

describe("isolation: the person must work for one of the flow's two companies", () => {
  it("refuses Edil (Jobutify only) for Alura Style → Alura Brand, a founder, someone who left, an inactive link — on create, edit and override", async () => {
    const n = t.ctx("nuraaly");
    const outsiders = [t.personIds.edil!, t.personIds.nuraaly!, left];
    const inactive = await addPerson("Old Staff", null, [{ company: "alura-brand", role: "manager", active: false }]);
    for (const id of [...outsiders, inactive]) {
      await expect(updateFlow(n, sew.id, { askPersonId: id })).rejects.toMatchObject({ code: "validation" });
      await expect(setAskOverride(n, sew.id, id)).rejects.toMatchObject({ code: "validation" });
      await expect(
        createFlow(n, { fromCompanyId: t.companyIds["alura-style"]!, toCompanyId: t.companyIds["alura-brand"]!, service: `x-${id.slice(0, 4)}`, askPersonId: id }),
      ).rejects.toMatchObject({ code: "validation" });
    }
    await expect(updateFlow(n, sew.id, { askPersonId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "validation" });
    // Edil works for Jobutify: fine for Jobutify → Kiwi Go.
    expect((await updateFlow(n, app.id, { askPersonId: t.personIds.edil })).askPerson?.name).toBe("Edil");
    await updateFlow(n, app.id, { askPersonId: t.personIds.elmurat });
  });
});

describe("grouping by person, wording, override per round", () => {
  it("different people → ONE section, one line per person, one button 'I asked them all'; RU message per person", async () => {
    const n = t.ctx("nuraaly", bishkek("2026-11-11", "07:00"));
    await updateFlow(n, app.id, { askPersonId: t.personIds.edil });
    await planHoldingAsks(t.handle.db, bishkek("2026-11-11", "07:00"), TZ);
    const s = await holdingSummarySection(n);
    expect(summaryLines(s)).toEqual([
      "Ask Edil for 1 missing акт: Jobutify → Kiwi Go (Oct)",
      "Ask Elmurat for 2 missing акты: Alura Style → Alura Brand (Sep, Oct)",
    ]);
    expect(s!.lines.filter((l) => l.text === "Holding · акты")).toHaveLength(1);
    expect(s!.actions).toEqual([{ label: "I asked them all", action: "holding_asked", askId: expect.any(String) }]);
    // Shown only when the last person's line made it in (the summary is cut from the end).
    expect(s!.lines.filter((l) => l.refs?.length)).toHaveLength(1);
    expect(s!.lines.at(-1)!.text).toContain("The messages (one per person) are ready to copy");

    const card = askCardFromGrid(await getActsGrid(n));
    expect(card.people.map((p) => p.person?.name)).toEqual(["Edil", "Elmurat"]);
    expect(card.people[0]!.message.split("\n")[0]).toBe("Эдил, пришлите, пожалуйста, акты приёма-передачи за:");
    expect(card.people[1]!.message.split("\n")[0]).toBe("Элмурат, пришлите, пожалуйста, акты приёма-передачи за:");
    expect(card.people[1]!.message).toContain("— Alura Style → Alura Brand (пошив): сентябрь, октябрь 2026");
  });

  it("nobody named → 'Ask the accountant…' and 'Здравствуйте! Пришлите…'", async () => {
    const n = t.ctx("nuraaly", bishkek("2026-11-11", "07:05"));
    await updateFlow(n, app.id, { askPersonId: null });
    const s = await holdingSummarySection(n);
    expect(summaryLines(s)).toEqual([
      "Ask Elmurat for 2 missing акты: Alura Style → Alura Brand (Sep, Oct)",
      "Ask the accountant for 1 missing акт: Jobutify → Kiwi Go (Oct)",
    ]);
    const card = askCardFromGrid(await getActsGrid(n));
    expect(card.people.at(-1)!.person).toBeNull();
    expect(card.people.at(-1)!.message.split("\n")[0]).toBe("Здравствуйте! Пришлите, пожалуйста, акты приёма-передачи за:");
  });

  it("one person for every flow → the old single line and 'I asked Elmurat'", async () => {
    const n = t.ctx("nuraaly", bishkek("2026-11-11", "07:10"));
    await updateFlow(n, app.id, { askPersonId: t.personIds.elmurat });
    const s = await holdingSummarySection(n);
    expect(summaryLines(s)).toEqual(["Ask Elmurat for 3 missing акты: Alura Style → Alura Brand (Sep, Oct), Jobutify → Kiwi Go (Oct)"]);
    expect(s!.actions!.map((a) => a.label)).toEqual(["I asked Elmurat"]);
    expect(s!.lines.at(-1)!.text).toContain("The message for Elmurat is ready to copy");
  });

  it("override for this round: Aigul instead of Elmurat (this month only); 'I asked' records Aigul; the reminder names her", async () => {
    const n = t.ctx("nuraaly", bishkek("2026-11-11", "07:20"));
    expect(await setAskOverride(n, sew.id, aigul)).toEqual({ roundKey: "2026-11" });
    const s = await holdingSummarySection(n);
    expect(summaryLines(s)).toEqual([
      "Ask Aigul for 2 missing акты: Alura Style → Alura Brand (Sep, Oct)",
      "Ask Elmurat for 1 missing акт: Jobutify → Kiwi Go (Oct)",
    ]);
    const card = askCardFromGrid(await getActsGrid(n));
    expect(card.people[0]!.message.split("\n")[0]).toBe("Айгуль, пришлите, пожалуйста, акты приёма-передачи за:");
    expect(card.flows.find((f) => f.flowId === sew.id)).toMatchObject({ overridden: true, person: { id: aigul }, flowPerson: { id: t.personIds.elmurat } });
    // The flow itself still asks Elmurat.
    expect((await listFlows(n)).find((f) => f.id === sew.id)!.askPerson?.id).toBe(t.personIds.elmurat);

    // Talant asks Aigul in the app.
    const tl = t.ctx("talant", bishkek("2026-11-11", "10:00"));
    expect(await markAskedInApp(tl, card.people[0]!.missing.cells, "missing")).toBe(2);
    const acts = await t.handle.db.select().from(intercompanyActs).where(eq(intercompanyActs.flowId, sew.id));
    expect(acts.map((a) => a.requestedPersonId)).toEqual([aigul, aigul]);

    // Next round (December): the override no longer applies to new missing months, but the
    // Monday reminder for what Aigul was asked still names her.
    const dec = t.ctx("nuraaly", bishkek("2026-12-14", "07:00"));
    await planHoldingAsks(t.handle.db, bishkek("2026-12-14", "07:00"), TZ);
    const s2 = await holdingSummarySection(dec);
    expect(summaryLines(s2)).toEqual([
      "Still waiting for 2 акты from Aigul (asked 11 Nov): Alura Style → Alura Brand (Sep, Oct)",
      "Ask Elmurat for 3 missing акты: Alura Style → Alura Brand (Nov), Jobutify → Kiwi Go (Oct, Nov)",
    ]);
    expect(s2!.actions!.map((a) => a.label)).toEqual(["I asked Elmurat", "I asked again"]);
  });

  it("clearing the override goes back to the flow's person", async () => {
    const n = t.ctx("nuraaly", bishkek("2026-12-14", "08:00"));
    await setAskOverride(n, app.id, t.personIds.edil!);
    expect(await t.handle.db.select().from(holdingAskOverrides).where(eq(holdingAskOverrides.roundKey, "2026-12"))).toHaveLength(1);
    await setAskOverride(n, app.id, null);
    expect(await t.handle.db.select().from(holdingAskOverrides).where(eq(holdingAskOverrides.roundKey, "2026-12"))).toHaveLength(0);
    const card = askCardFromGrid(await getActsGrid(n));
    expect(card.flows.find((f) => f.flowId === app.id)).toMatchObject({ overridden: false, person: { id: t.personIds.elmurat } });
  });

  it("superseded rounds still collapse: one pending ask item per founder", async () => {
    const pending = await t.handle.db
      .select()
      .from(holdingAskItems)
      .where(and(eq(holdingAskItems.userId, t.userIds.nuraaly), eq(holdingAskItems.status, "pending"), eq(holdingAskItems.kind, "ask")));
    expect(pending.length).toBeLessThanOrEqual(1);
  });

  it("nothing is ever queued for anyone but the two founders", async () => {
    const recipients = await t.handle.db.selectDistinct({ userId: notificationsOutbox.userId }).from(notificationsOutbox);
    const founders = await t.handle.db.select({ id: users.id }).from(users).where(eq(users.role, "founder"));
    for (const r of recipients) expect(founders.map((f) => f.id)).toContain(r.userId);
    expect((await t.handle.db.select().from(people).where(eq(people.id, aigul)))[0]!.userId).toBeNull();
    // The flow rows store a person id only (no contact is ever used).
    const rows = await t.handle.db.select({ ask: intercompanyFlows.askPersonId }).from(intercompanyFlows);
    expect(rows.every((r) => r.ask === null || typeof r.ask === "string")).toBe(true);
  });
});
