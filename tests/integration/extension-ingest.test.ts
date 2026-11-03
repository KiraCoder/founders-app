import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { middleware } from "@/middleware";
import { companies, extensionIngestLog, extensionKeys, ingestRateCounters, metricDefinitions, metricValues } from "@/server/db/schema";
import { handleIngestPreflight, handleIngestRequest } from "@/server/http/ingest";
import type { ServiceContext } from "@/server/services/context";
import { createExtensionKey, hashKey, INGEST_RATE_LIMIT, listExtensionKeys, listIngestLog, revokeExtensionKey } from "@/server/services/extension";
import { listCompanyMetricCards, recordMetricValue } from "@/server/services/metrics";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";

let t: TestDb;
let key: string;
let keyId: string;
let now = FIXED_NOW;
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const staff = (): ServiceContext => ({ ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, id: crypto.randomUUID(), role: "staff" } });

function post(body: unknown, headers: Record<string, string> = {}, raw?: string): Request {
  return new Request("http://app.test/api/v1/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
    body: raw ?? JSON.stringify(body),
  });
}
const send = (req: Request) => handleIngestRequest(req, { db: t.handle.db, now: () => now });
const env = (points: unknown[], adapterId = "wb-seller") => ({ source: "extension", adapterId, points });
const pt = (companySlug: string, metricKey: string, periodStart: string, value: unknown, extra: Record<string, unknown> = {}) => ({ companySlug, metricKey, periodStart, value, ...extra });

async function current(companySlug: string, metricKey: string, period: string) {
  const [row] = await t.handle.db
    .select({ value: metricValues.value, source: metricValues.source })
    .from(metricValues)
    .innerJoin(metricDefinitions, eq(metricDefinitions.id, metricValues.metricId))
    .where(and(eq(metricDefinitions.companyId, t.companyIds[companySlug]!), eq(metricDefinitions.key, metricKey), eq(metricValues.periodStart, period), eq(metricValues.isCurrent, true)));
  return row ?? null;
}

beforeAll(async () => {
  t = await createTestDb();
  const created = await createExtensionKey(t.ctx("nuraaly"), { name: "Laptop Chrome" });
  key = created.key;
  keyId = created.view.id;
});
afterAll(async () => {
  await t.handle.close();
});

describe("personal keys (Settings → Browser extension)", () => {
  it("shown once, stored as SHA-256 only; founders only; each founder sees and revokes only their own", async () => {
    expect(key).toMatch(/^fcx_[A-Za-z0-9_-]{43}$/);
    const [row] = await t.handle.db.select().from(extensionKeys).where(eq(extensionKeys.id, keyId));
    expect(row!.keyHash).toBe(hashKey(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect((await listExtensionKeys(t.ctx("nuraaly"))).map((k) => [k.name, k.prefix])).toEqual([["Laptop Chrome", key.slice(0, 8)]]);
    expect(await listExtensionKeys(t.ctx("talant"))).toEqual([]);
    await expect(revokeExtensionKey(t.ctx("talant"), keyId)).rejects.toMatchObject({ code: "not_found" });
    await expect(createExtensionKey(staff(), { name: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listIngestLog(staff())).rejects.toMatchObject({ code: "forbidden" });
    await expect(createExtensionKey(t.ctx("talant"), { name: " " })).rejects.toBeTruthy();
  });
});

describe("POST /api/v1/ingest", () => {
  it("auth: missing, wrong and revoked keys get 401 (nothing logged)", async () => {
    const body = env([pt("kiwi-go", "revenue", "2026-09-01", "100")]);
    expect((await send(post(body, { authorization: "" }))).status).toBe(401);
    expect((await send(post(body, { authorization: "Bearer fcx_nope" }))).status).toBe(401);
    expect((await send(post(body, { authorization: `Basic ${key}` }))).status).toBe(401);
    const other = await createExtensionKey(t.ctx("talant"), { name: "Old laptop" });
    await revokeExtensionKey(t.ctx("talant"), other.view.id);
    const res = await send(post(body, { authorization: `Bearer ${other.key}` }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
    expect(await t.handle.db.select().from(extensionIngestLog)).toHaveLength(0);
  });

  it("accepts points through the metric write path (source extension, exact decimals) and logs the call", async () => {
    const res = await send(
      post(
        env([
          pt("kiwi-go", "revenue", "2026-08-01", "1234567.89"),
          pt("kiwi-go", "orders_day", "2026-10-31", "1 250"),
          pt("alura-style", "output_pcs", "2026-10-30", "800", { unitSlug: "hbk" }),
        ]),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 3, rejected: [] });
    expect(await current("kiwi-go", "revenue", "2026-08-01")).toEqual({ value: "1234567.8900", source: "extension" });
    expect(await current("kiwi-go", "orders_day", "2026-10-31")).toEqual({ value: "1250.0000", source: "extension" });
    const log = await listIngestLog(t.ctx("talant"));
    expect(log[0]).toMatchObject({ keyName: "Laptop Chrome", ownerName: "Nuraaly", adapterId: "wb-seller", status: "ok", points: 3, accepted: 3, rejected: 0 });
    expect((await listExtensionKeys(t.ctx("nuraaly")))[0]!.lastUsedAt).toBe(FIXED_NOW.toISOString());
    const card = (await listCompanyMetricCards(t.ctx("nuraaly"), t.companyIds["kiwi-go"]!)).find((c) => c.key === "orders_day")!;
    expect(card.latest).toMatchObject({ source: "extension", enteredByName: "Nuraaly" });
  });

  it("per-point rejections with reasons; the rest is written", async () => {
    const res = await send(
      post(
        env([
          pt("kiwi-go", "revenue", "2026-07-01", "500"), // 0 ok
          pt("no-such-co", "revenue", "2026-07-01", "1"), // 1
          pt("kiwi-go", "nope", "2026-07-01", "1"), // 2
          pt("kiwi-go", "revenue", "2026-07-01", 5), // 3 not a string
          pt("kiwi-go", "revenue", "2026-06-01", "85.000"), // 4 ambiguous
          pt("kiwi-go", "revenue", "2026-12-01", "1"), // 5 future
          pt("kiwi-go", "revenue", "2026-11-01", "1"), // 6 unfinished month
          pt("kiwi-go", "revenue", "2026-06-15", "1"), // 7 not the first day
          pt("kiwi-go", "revenue", "2026-06", "1"), // 8 not YYYY-MM-DD
          pt("alura-style", "output_pcs", "2026-10-30", "1"), // 9 per factory, no unitSlug
          pt("asqa-zou-holding", "intercompany_debt", "2026-09-01", "1"), // 10 holding-fed
          { ...pt("kiwi-go", "revenue", "2026-05-01", "1"), extra: 1 }, // 11 unknown field
          pt("kiwi-go", "revenue", "2026-04-01", "1"), // 12 duplicate
          pt("kiwi-go", "revenue", "2026-04-01", "2"), // 13 duplicate
          "nonsense", // 14
          pt("kiwi-go", "on_time_pct", "2026-10-30", "95.5%"), // 15 ok (% for a % number)
          pt("kiwi-go", "revenue", "2026-03-01", "12%"), // 16 % for a KGS number
        ]),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number; rejected: { index: number; reason: string }[] };
    expect(body.accepted).toBe(2);
    expect(body.rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16]);
    const reason = (i: number) => body.rejected.find((r) => r.index === i)!.reason;
    expect(reason(1)).toBe("Unknown company: no-such-co");
    expect(reason(2)).toBe("Unknown number for Kiwi Go: nope");
    expect(reason(3)).toContain("value must be a string");
    expect(reason(4)).toContain("ambiguous");
    expect(reason(5)).toMatch(/future/i);
    expect(reason(6)).toBe("This month isn't finished yet");
    expect(reason(7)).toBe("periodStart must be the first day of its month: 2026-06-01");
    expect(reason(8)).toContain("YYYY-MM-DD");
    expect(reason(9)).toContain("add unitSlug");
    expect(reason(10)).toContain("computed from the Holding");
    expect(reason(11)).toBe("Unknown field: extra");
    expect(reason(12)).toBe("Points 12, 13 are the same number and period — send one");
    expect(await current("kiwi-go", "revenue", "2026-07-01")).toEqual({ value: "500.0000", source: "extension" });
    expect(await current("kiwi-go", "revenue", "2026-04-01")).toBeNull();
    expect(await current("kiwi-go", "on_time_pct", "2026-10-30")).toEqual({ value: "95.5000", source: "extension" });
  });

  it("never overwrites a manual or uploaded value: a conflict is rejected and shown as 'source disagrees'; latest wins among extension values", async () => {
    const kiwi = t.companyIds["kiwi-go"]!;
    const [rev] = await t.handle.db.select().from(metricDefinitions).where(and(eq(metricDefinitions.companyId, kiwi), eq(metricDefinitions.key, "revenue")));
    await recordMetricValue(t.ctx("talant"), rev!.id, { period: "2026-09", value: 100 });
    now = new Date(FIXED_NOW.getTime() + 1000);
    const res = await send(post(env([pt("kiwi-go", "revenue", "2026-09-01", "120"), pt("kiwi-go", "revenue", "2026-07-01", "650")])));
    const body = (await res.json()) as { accepted: number; rejected: { index: number; reason: string }[] };
    expect(body.accepted).toBe(1);
    expect(body.rejected).toEqual([{ index: 0, reason: "A founder entered 100 for this period — kept (recorded as “source disagrees”)" }]);
    expect(await current("kiwi-go", "revenue", "2026-09-01")).toEqual({ value: "100.0000", source: "manual" });
    // Latest wins among extension values (history kept).
    expect(await current("kiwi-go", "revenue", "2026-07-01")).toEqual({ value: "650.0000", source: "extension" });
    const history = await t.handle.db.select().from(metricValues).where(and(eq(metricValues.metricId, rev!.id), eq(metricValues.periodStart, "2026-07-01")));
    expect(history).toHaveLength(2);
    const card = (await listCompanyMetricCards(t.ctx("nuraaly"), kiwi)).find((c) => c.key === "revenue")!;
    expect(card.disagreements).toEqual([expect.objectContaining({ period: "2026-09-01", kept: 100, keptSource: "manual", reported: 120, connectorId: "extension:wb-seller" })]);
    // A later call about other numbers keeps the disagreement on the card.
    now = new Date(FIXED_NOW.getTime() + 2000);
    await send(post(env([pt("kiwi-go", "revenue", "2026-06-01", "1")])));
    expect((await listCompanyMetricCards(t.ctx("nuraaly"), kiwi)).find((c) => c.key === "revenue")!.disagreements).toHaveLength(1);
    // The same number as the founder's: accepted, nothing written, the disagreement clears.
    now = new Date(FIXED_NOW.getTime() + 3000);
    const same = (await (await send(post(env([pt("kiwi-go", "revenue", "2026-09-01", "100")])))).json()) as { accepted: number };
    expect(same.accepted).toBe(1);
    expect(await current("kiwi-go", "revenue", "2026-09-01")).toEqual({ value: "100.0000", source: "manual" });
    expect((await listCompanyMetricCards(t.ctx("nuraaly"), kiwi)).find((c) => c.key === "revenue")!.disagreements).toEqual([]);
    expect((await listIngestLog(t.ctx("nuraaly")))[2]).toMatchObject({ conflicts: 1, rejected: 1, accepted: 1 });
  });

  it("isolation: a company the owner can't access (archived) is unknown", async () => {
    await t.handle.db.update(companies).set({ archivedAt: now }).where(eq(companies.slug, "marketing"));
    await t.handle.db.insert(metricDefinitions).values({ companyId: t.companyIds["marketing"]!, key: "leads", name: "Leads", unit: "count", granularity: "month" });
    const body = (await (await send(post(env([pt("marketing", "leads", "2026-09-01", "5")])))).json()) as { rejected: { reason: string }[] };
    expect(body.rejected[0]!.reason).toBe("Unknown company: marketing");
  });

  it("request validation: content type, JSON, envelope, 500 points, 256 KB (logged as refused)", async () => {
    expect((await send(post(null, { "content-type": "text/plain" }, "x"))).status).toBe(415);
    expect((await send(post(null, {}, "{not json"))).status).toBe(400);
    expect((await send(post({ source: "other", adapterId: "a", points: [] }))).status).toBe(400);
    expect((await send(post({ source: "extension", adapterId: "bad id!", points: [] }))).status).toBe(400);
    const many = await send(post(env(Array.from({ length: 501 }, () => pt("kiwi-go", "revenue", "2026-01-01", "1")))));
    expect(many.status).toBe(400);
    expect((await many.json()).error.message).toContain("At most 500 points");
    const big = await send(post(null, {}, JSON.stringify(env([{ companySlug: "x".repeat(300_000) }]))));
    expect(big.status).toBe(413);
    const refused = (await listIngestLog(t.ctx("nuraaly"), 50)).filter((l) => l.status === "invalid");
    expect(refused.length).toBe(6);
  });

  it(`rate limit: ${INGEST_RATE_LIMIT} calls per key per minute, counted before processing (refused calls count too)`, async () => {
    now = new Date(FIXED_NOW.getTime() + 3_600_000 + 15_000);
    for (let i = 0; i < INGEST_RATE_LIMIT - 2; i++) expect((await send(post(env([])))).status).toBe(200);
    expect((await send(post(null, {}, "{not json"))).status).toBe(400); // the 59th: refused, still counts
    expect((await send(post(env([])))).status).toBe(200); // the 60th
    const limited = await send(post(env([])));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("45"); // until the minute ends
    now = new Date(now.getTime() + 45_000);
    expect((await send(post(env([])))).status).toBe(200);
  });

  it("rate limit holds under parallel requests: 150 at once → exactly 60 pass", async () => {
    now = new Date(FIXED_NOW.getTime() + 7_200_000);
    const before = (await t.handle.db.select().from(extensionIngestLog)).length;
    const res = await Promise.all(Array.from({ length: 150 }, () => send(post(env([pt("kiwi-go", "orders_day", "2026-10-29", "7")])))));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(INGEST_RATE_LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(150 - INGEST_RATE_LIMIT);
    expect((await t.handle.db.select().from(extensionIngestLog)).length - before).toBe(INGEST_RATE_LIMIT);
    const [counter] = await t.handle.db.select().from(ingestRateCounters).where(eq(ingestRateCounters.bucket, `key:${keyId}`)).orderBy(desc(ingestRateCounters.windowStart)).limit(1);
    expect(counter!.n).toBe(150);
  });

  it("a call that fails inside (500) still used its slot", async () => {
    now = new Date(FIXED_NOW.getTime() + 10_800_000);
    const real = t.handle.db;
    const broken = new Proxy(real, {
      get: (target, prop) => (prop === "transaction" ? () => Promise.reject(new Error("boom")) : Reflect.get(target, prop, target)),
    });
    const err = console.error;
    console.error = () => undefined;
    try {
      const res = await handleIngestRequest(post(env([pt("kiwi-go", "orders_day", "2026-10-28", "7")])), { db: broken, now: () => now });
      expect(res.status).toBe(500);
    } finally {
      console.error = err;
    }
    const [counter] = await t.handle.db.select().from(ingestRateCounters).where(eq(ingestRateCounters.bucket, `key:${keyId}`)).orderBy(desc(ingestRateCounters.windowStart)).limit(1);
    expect(counter!.n).toBe(1);
  });

  it("CORS: chrome-extension origins only, with preflight; other web origins are refused", async () => {
    const pre = handleIngestPreflight(new Request("http://app.test/api/v1/ingest", { method: "OPTIONS", headers: { origin: EXT, "access-control-request-method": "POST" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(EXT);
    expect(pre.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
    expect(pre.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    const evil = handleIngestPreflight(new Request("http://app.test/api/v1/ingest", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    now = new Date(now.getTime() + 3_600_000);
    const fromExt = await send(post(env([]), { origin: EXT }));
    expect(fromExt.status).toBe(200);
    expect(fromExt.headers.get("access-control-allow-origin")).toBe(EXT);
    const fromWeb = await send(post(env([]), { origin: "https://evil.example" }));
    expect(fromWeb.status).toBe(403);
    expect(fromWeb.headers.get("access-control-allow-origin")).toBeNull();
    // Errors carry CORS headers too (the extension can read why).
    const unauth = await send(post(env([]), { origin: EXT, authorization: "Bearer fcx_wrong" }));
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("access-control-allow-origin")).toBe(EXT);
  });

  it("the middleware lets the route through without a session or same-origin check (the route checks the key)", async () => {
    const base = "http://app.test";
    const pass = (r: Response) => r.headers.get("x-middleware-next") === "1";
    expect(pass(await middleware(new NextRequest(`${base}/api/v1/ingest`, { method: "POST", headers: { origin: EXT, "content-type": "application/json" } })))).toBe(true);
    expect(pass(await middleware(new NextRequest(`${base}/api/v1/ingest`, { method: "OPTIONS", headers: { origin: EXT } })))).toBe(true);
    // Other API routes still need the session and the same-origin guard.
    expect((await middleware(new NextRequest(`${base}/api/v1/ingestx`, { method: "POST", headers: { origin: EXT, "content-type": "application/json" } }))).status).toBe(403);
    expect((await middleware(new NextRequest(`${base}/api/v1/tasks`, { method: "POST", headers: { origin: EXT, "content-type": "application/json" } }))).status).toBe(403);
  });
});
