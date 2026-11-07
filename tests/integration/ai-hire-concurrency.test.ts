import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { aiRoleHires, aiRoleSettingsLog } from "@/server/db/schema";
import { getHire, hireRole, updateHire } from "@/server/services/ai-roles";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let kiwi: string;

beforeAll(async () => {
  t = await createTestDb();
  kiwi = t.companyIds["kiwi-go"]!;
});
afterAll(async () => {
  await t.handle.close();
});

const log = (scopeKey: string) => t.handle.db.select().from(aiRoleSettingsLog).where(eq(aiRoleSettingsLog.scopeKey, scopeKey)).orderBy(asc(aiRoleSettingsLog.version));

describe("updateHire: one transaction with the row locked (C5b #11)", () => {
  it("two edits at once both land, and each version logs the right `before`", async () => {
    const ctx = t.ctx("nuraaly");
    const hire = await hireRole(ctx, { templateKey: "financial-analyst", companyId: kiwi });
    const [original] = await t.handle.db.select({ settings: aiRoleHires.settings, notes: aiRoleHires.notes }).from(aiRoleHires).where(eq(aiRoleHires.id, hire.id));
    const start = (await log(`hire:${hire.id}`)).length;
    await Promise.all([
      updateHire(t.ctx("nuraaly"), hire.id, { settings: { schedule: { kind: "monthly", day: 20 } } }),
      updateHire(t.ctx("talant"), hire.id, { settings: { thresholds: { changePct: 15, riskChangePct: 40 } } }),
      updateHire(t.ctx("talant"), hire.id, { notes: "Watch COD" }),
    ]);
    const final = await getHire(ctx, hire.id);
    expect(final.settings.schedule).toEqual({ kind: "monthly", day: 20 });
    expect(final.settings.thresholds).toEqual({ changePct: 15, riskChangePct: 40 });
    expect(final.notes).toBe("Watch COD");
    const rows = (await log(`hire:${hire.id}`)).slice(start);
    expect(rows.map((r) => r.action)).toEqual(["edit", "edit", "edit"]);
    expect(rows[0]!.before).toEqual({ settings: original!.settings, notes: original!.notes });
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.before, `v${rows[i]!.version}`).toEqual(rows[i - 1]!.after);
    expect(rows.at(-1)!.after).toEqual({ settings: (await t.handle.db.select({ s: aiRoleHires.settings }).from(aiRoleHires).where(and(eq(aiRoleHires.id, hire.id))))[0]!.s, notes: "Watch COD" });
  });
});
