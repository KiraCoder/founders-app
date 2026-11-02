import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localAuthProvider } from "@/server/auth/local";
import { resolveSessionSecret, verifySessionToken } from "@/server/auth/session-token";
import { getCompanyBySlug, listCompanyCards } from "@/server/services/companies";
import { listPeople } from "@/server/services/people";
import { listTasks } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ withSamples: true });
});
afterAll(async () => {
  await t.handle.close();
});

describe("seed", () => {
  it("creates the seven companies in order, Alura Style with two factories", async () => {
    const cards = await listCompanyCards(t.ctx("nuraaly"));
    expect(cards.map((c) => c.name)).toEqual([
      "Kiwi Go",
      "Jobutify",
      "Alura Brand",
      "Alura Style",
      "Upsell Group",
      "Marketing",
      "Asqa Zou Holding",
    ]);
    expect(cards.find((c) => c.slug === "marketing")?.status).toBe("planned");
    const alura = await getCompanyBySlug(t.ctx("nuraaly"), "alura-style");
    expect(alura.units.map((u) => u.name)).toEqual(["ХБК", "Ош Район"]);
  });

  it("links Elmurat to several companies and Edil to Jobutify", async () => {
    const people = await listPeople(t.ctx("nuraaly"));
    const elmurat = people.find((p) => p.fullName === "Elmurat")!;
    expect(elmurat.roles.length).toBeGreaterThan(2);
    const jobutifyPeople = await listPeople(t.ctx("nuraaly"), { companyId: t.companyIds["jobutify"] });
    expect(jobutifyPeople.map((p) => p.fullName)).toContain("Edil");
  });

  it("has sample tasks: one overdue and one personal todo per founder", async () => {
    const n = await listTasks(t.ctx("nuraaly"), { view: "my" });
    const tl = await listTasks(t.ctx("talant"), { view: "my" });
    expect(n.every((x) => x.title.startsWith("[sample]"))).toBe(true);
    expect(n).toHaveLength(1);
    expect(tl).toHaveLength(1);
    expect(n[0]!.id).not.toBe(tl[0]!.id);
    const overdue = await listTasks(t.ctx("nuraaly"), { view: "overdue" });
    expect(overdue.length).toBeGreaterThanOrEqual(1);
  });
});

describe("re-running the seed", () => {
  it("keeps existing founders' passwords and sessions unless resetPasswords is set", async () => {
    const { seed } = await import("@/server/db/seed");
    const before = await localAuthProvider.signIn(t.handle.db, "talant@founders.local", "test-password");
    expect(before).not.toBeNull();

    await seed(t.handle.db, { password: "another-password", bcryptRounds: 4 });
    expect(await localAuthProvider.signIn(t.handle.db, "talant@founders.local", "another-password")).toBeNull();
    expect(await localAuthProvider.getUser(t.handle.db, before!.token)).not.toBeNull();

    await seed(t.handle.db, { password: "another-password", bcryptRounds: 4, resetPasswords: true });
    // Old sessions are revoked, the new password works, the old one does not.
    expect(await localAuthProvider.getUser(t.handle.db, before!.token)).toBeNull();
    expect(await localAuthProvider.signIn(t.handle.db, "talant@founders.local", "another-password")).not.toBeNull();
    expect(await localAuthProvider.signIn(t.handle.db, "talant@founders.local", "test-password")).toBeNull();

    // Restore for the other tests in this file.
    await seed(t.handle.db, { password: "test-password", bcryptRounds: 4, resetPasswords: true });
  });

  it("adds no sample tasks unless asked", async () => {
    const fresh = await createTestDb({ withSamples: false });
    try {
      expect(await listTasks(fresh.ctx("nuraaly"), { status: "any" })).toHaveLength(0);
    } finally {
      await fresh.handle.close();
    }
  });
});

describe("local auth", () => {
  it("signs in with the right password and resolves the session", async () => {
    const res = await localAuthProvider.signIn(t.handle.db, "Nuraaly@Founders.local ", "test-password");
    expect(res?.user.shortName).toBe("Nuraaly");
    expect(res && "passwordHash" in res.user).toBe(false);
    const user = await localAuthProvider.getUser(t.handle.db, res!.token);
    expect(user?.id).toBe(t.userIds.nuraaly);

    await localAuthProvider.signOut(t.handle.db, res!.token);
    expect(await localAuthProvider.getUser(t.handle.db, res!.token)).toBeNull();
    // Cookie signature is still valid, but the revoked session is rejected by the DB check.
    expect(await verifySessionToken(res!.token)).not.toBeNull();
  });

  it("rejects wrong passwords, unknown users and tampered tokens", async () => {
    expect(await localAuthProvider.signIn(t.handle.db, "talant@founders.local", "nope")).toBeNull();
    expect(await localAuthProvider.signIn(t.handle.db, "ghost@founders.local", "test-password")).toBeNull();
    const res = await localAuthProvider.signIn(t.handle.db, "talant@founders.local", "test-password");
    expect(await localAuthProvider.getUser(t.handle.db, res!.token + "x")).toBeNull();
    expect(await localAuthProvider.getUser(t.handle.db, undefined)).toBeNull();
  });

  it("refuses to run in production without SESSION_SECRET", () => {
    expect(() => resolveSessionSecret({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET/);
    expect(() => resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "short" })).toThrow();
    expect(resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(40) })).toBe("x".repeat(40));
    expect(resolveSessionSecret({ NODE_ENV: "development" })).toMatch(/INSECURE-DEV-ONLY/);
  });
});
