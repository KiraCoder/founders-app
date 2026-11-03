import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { aiRoleConfigs, aiRoleSettingsLog } from "@/server/db/schema";
import { createCustomRole, listHireVersions, listRoleVersions, resetHire, resetRoleToDefaults, revertRole, updateRoleConfig } from "@/server/services/ai-role-editor";
import { getHire, hireRole, updateHire } from "@/server/services/ai-roles";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let kiwi: string;
let jobutify: string;

beforeAll(async () => {
  t = await createTestDb();
  kiwi = t.companyIds["kiwi-go"]!;
  jobutify = t.companyIds["jobutify"]!;
});
afterAll(async () => {
  await t.handle.close();
});

const log = (scopeKey: string) => t.handle.db.select().from(aiRoleSettingsLog).where(eq(aiRoleSettingsLog.scopeKey, scopeKey)).orderBy(asc(aiRoleSettingsLog.version));

describe("Reset to defaults (C5b #6)", () => {
  it("a built-in role goes back to the code's defaults, logged as a version that can be reverted", async () => {
    const ctx = t.ctx("nuraaly");
    await updateRoleConfig(ctx, "financial-analyst", { profile: { name: "Money watcher", instructions: "Be brief." }, schedule: { kind: "monthly", day: 15 } });
    const reset = await resetRoleToDefaults(ctx, "financial-analyst");
    expect(reset.name).toBe("Financial Analyst");
    expect(reset.defaultSchedule).toEqual({ kind: "monthly", day: 10 });
    const [row] = await t.handle.db.select().from(aiRoleConfigs).where(eq(aiRoleConfigs.key, "financial-analyst"));
    expect(row!.config).toEqual({});
    const versions = await listRoleVersions(ctx, "financial-analyst");
    expect(versions.map((v) => [v.version, v.action])).toEqual([
      [2, "reset"],
      [1, "edit"],
    ]);
    expect(versions[0]!.before).toMatchObject({ profile: { name: "Money watcher" } });
    // Already at the defaults: nothing new is logged.
    await resetRoleToDefaults(ctx, "financial-analyst");
    expect(await log("role:financial-analyst")).toHaveLength(2);
    // The reset is a version like any other: revert to before it.
    expect((await revertRole(ctx, "financial-analyst", 1)).name).toBe("Money watcher");
    await resetRoleToDefaults(ctx, "financial-analyst");
  });

  it("a custom role goes back to its first version (as created)", async () => {
    const ctx = t.ctx("talant");
    const role = await createCustomRole(ctx, { companyId: kiwi, config: { profile: { name: "Revenue watcher" }, watchedMetricKeys: ["revenue"] } });
    await updateRoleConfig(ctx, role.key, { profile: { name: "Renamed" }, watchedMetricKeys: ["revenue", "orders_day"] });
    const reset = await resetRoleToDefaults(ctx, role.key);
    expect(reset.name).toBe("Revenue watcher");
    expect(reset.watchedMetricKeys).toEqual(["revenue"]);
    expect((await log(`role:${role.key}`)).map((r) => r.action)).toEqual(["create", "edit", "reset"]);
  });

  it("a hire goes back to the role's defaults: own checks / name / schedule / limits cleared, notes kept", async () => {
    const ctx = t.ctx("nuraaly");
    const hire = await hireRole(ctx, { templateKey: "org-structure-expert", companyId: jobutify });
    const defaults = hire.settings;
    await updateHire(ctx, hire.id, {
      settings: { schedule: { kind: "weekly", weekday: 3 }, maxDepartmentsPerHead: 2, checks: { department_no_head: { enabled: false } }, profile: { name: "Org buddy" } },
      notes: "Keep me",
    });
    const edited = await getHire(ctx, hire.id);
    expect(edited.roleName).toBe("Org buddy");
    const reset = await resetHire(ctx, hire.id);
    expect(reset.settings).toEqual(defaults);
    expect(reset.roleName).toBe("Org Structure Expert");
    expect(reset.scheduleLabel).toBe("Weekly on Mondays");
    expect(reset.notes).toBe("Keep me");
    const versions = await listHireVersions(ctx, hire.id);
    expect(versions[0]).toMatchObject({ action: "reset" });
    expect(versions[0]!.before).toMatchObject({ settings: { profile: { name: "Org buddy" } } });
  });
});
