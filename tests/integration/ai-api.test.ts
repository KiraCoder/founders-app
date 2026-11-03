import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ServiceContext } from "@/server/services/context";
import { runHireNow } from "@/server/services/ai-roles";
import { createTestDb, type TestDb } from "../helpers/db";

const state = vi.hoisted(() => ({ ctx: null as ServiceContext | null }));
vi.mock("@/server/context", () => ({
  getApiContext: async () => state.ctx,
  getPageContext: async () => state.ctx,
}));

const { GET: rolesGet, POST: rolesPost } = await import("@/app/api/v1/ai/roles/route");
const { GET: hireGet, PATCH: hirePatch } = await import("@/app/api/v1/ai/hires/[id]/route");
const { GET: runGet } = await import("@/app/api/v1/ai/runs/[id]/route");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});

const as = (who: "nuraaly" | "talant" | "staff" | null) => {
  state.ctx = who === null ? null : who === "staff" ? { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" } } : t.ctx(who);
};
const req = (url: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/v1/ai", () => {
  let hireId: string;
  it("401 signed out, 403 for staff", async () => {
    as(null);
    expect((await rolesGet(req("/api/v1/ai/roles"))).status).toBe(401);
    as("staff");
    expect((await rolesGet(req("/api/v1/ai/roles"))).status).toBe(403);
  });
  it("GET roles: catalogue (Financial Analyst available, three coming soon) and provider none", async () => {
    as("talant");
    const data = (await (await rolesGet(req("/api/v1/ai/roles"))).json()).data;
    expect(data.templates.map((x: { key: string; status: string }) => `${x.key}:${x.status}`)).toEqual([
      "financial-analyst:available",
      "hr:coming_soon",
      "marketing:coming_soon",
      "operations:coming_soon",
    ]);
    expect(data.hires).toEqual([]);
    expect(data.provider).toEqual({ id: "none", configured: false });
  });
  it("POST hires (201), a second time 409, bad body 400", async () => {
    as("nuraaly");
    const body = { templateKey: "financial-analyst", companyId: t.companyIds["alura-style"], settings: { schedule: { kind: "monthly", day: 12 } } };
    const res = await rolesPost(req("/api/v1/ai/roles", { method: "POST", body }));
    expect(res.status).toBe(201);
    const hire = (await res.json()).data;
    hireId = hire.id;
    expect(hire).toMatchObject({ companyName: "Alura Style", scheduleLabel: "Monthly on the 12th" });
    expect(hire.settings.requiredMetricKeys).toEqual(["output_pcs", "piecework_total", "defect_pct"]);
    expect((await rolesPost(req("/api/v1/ai/roles", { method: "POST", body }))).status).toBe(409);
    expect((await rolesPost(req("/api/v1/ai/roles", { method: "POST", body: { templateKey: "financial-analyst", companyId: "x", extra: 1 } }))).status).toBe(400);
  });
  it("GET / PATCH hire: tune, pause; invalid ids 404", async () => {
    as("talant");
    const got = (await (await hireGet(req(`/api/v1/ai/hires/${hireId}`), params(hireId))).json()).data;
    expect(got).toMatchObject({ id: hireId, runs: [] });
    const tuned = await hirePatch(req(`/api/v1/ai/hires/${hireId}`, { method: "PATCH", body: { settings: { thresholds: { changePct: 15, riskChangePct: 40 } }, status: "paused" } }), params(hireId));
    expect(tuned.status).toBe(200);
    expect((await tuned.json()).data).toMatchObject({ status: "paused", settings: { thresholds: { changePct: 15, riskChangePct: 40 } } });
    expect((await hirePatch(req(`/api/v1/ai/hires/${hireId}`, { method: "PATCH", body: {} }), params(hireId))).status).toBe(400);
    expect((await hireGet(req("/api/v1/ai/hires/nope"), params("nope"))).status).toBe(404);
  });
  it("GET run: the waiting report with what is missing", async () => {
    as("nuraaly");
    await hirePatch(req(`/api/v1/ai/hires/${hireId}`, { method: "PATCH", body: { status: "active" } }), params(hireId));
    const run = await runHireNow(t.ctx("nuraaly"), hireId);
    const data = (await (await runGet(req(`/api/v1/ai/runs/${run.id}`), params(run.id))).json()).data;
    expect(data).toMatchObject({ status: "waiting_for_data", periodLabel: "October 2026", numbersHref: "/companies/alura-style?tab=numbers&g=day" });
    expect(data.missing.map((m: { label: string }) => m.label)).toContain("Output per day · ХБК");
    as("staff");
    expect((await runGet(req(`/api/v1/ai/runs/${run.id}`), params(run.id))).status).toBe(403);
  });
});
