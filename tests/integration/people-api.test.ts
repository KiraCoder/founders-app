import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ServiceContext } from "@/server/services/context";
import { createTestDb, type TestDb } from "../helpers/db";

// The route handlers resolve the signed-in user through getApiContext(); point it at the test DB.
const state = vi.hoisted(() => ({ ctx: null as ServiceContext | null }));
vi.mock("@/server/context", () => ({
  getApiContext: async () => state.ctx,
  getPageContext: async () => state.ctx,
}));

const { GET: listRoute, POST: createRoute } = await import("@/app/api/v1/people/route");
const { GET: getRoute, PATCH: patchRoute } = await import("@/app/api/v1/people/[id]/route");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});

const as = (who: "nuraaly" | "talant" | null) => {
  state.ctx = who ? t.ctx(who) : null;
};
const req = (url: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/v1/people", () => {
  let personId: string;
  let linkId: string;

  it("401 when signed out", async () => {
    as(null);
    expect((await listRoute(req("/api/v1/people"))).status).toBe(401);
  });

  it("POST with a salary: allowed for Nuraaly, 403 for Talant (nothing created)", async () => {
    const body = {
      fullName: "Апи Тестов",
      phone: "+996 555 000 042",
      links: [{ companyId: t.companyIds["kiwi-go"], role: "Курьер", salary: { amount: 27500 } }],
    };
    as("talant");
    const refused = await createRoute(req("/api/v1/people", { method: "POST", body }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("forbidden");

    as("nuraaly");
    const res = await createRoute(req("/api/v1/people", { method: "POST", body }));
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    personId = data.id;
    linkId = data.roles[0].id;

    as("talant");
    const list = await (await listRoute(req("/api/v1/people?q=Апи"))).json();
    expect(list.data).toHaveLength(1);
  });

  it("GET list and GET one: salary only for the viewer", async () => {
    as("nuraaly");
    const nList = await (await listRoute(req("/api/v1/people?companyId=" + t.companyIds["kiwi-go"]))).json();
    const nRow = nList.data.find((p: { id: string }) => p.id === personId);
    expect(nRow.roles[0].salary.amount).toBe(27500);
    const nOne = await (await getRoute(req(`/api/v1/people/${personId}`), params(personId))).json();
    expect(nOne.data.roles[0].salaryHistory).toHaveLength(1);

    as("talant");
    const tListRes = await listRoute(req("/api/v1/people?companyId=" + t.companyIds["kiwi-go"]));
    const tText = await tListRes.text();
    expect(tText).not.toContain("salary");
    expect(tText).not.toContain("27500");
    const tOne = await (await getRoute(req(`/api/v1/people/${personId}`), params(personId))).text();
    expect(tOne).not.toContain("salary");
    expect(tOne).not.toContain("27500");
  });

  it("PATCH: Talant can edit fields and mark as left, but salary changes are 403", async () => {
    as("talant");
    const edit = await patchRoute(req(`/api/v1/people/${personId}`, { method: "PATCH", body: { notes: "API note" } }), params(personId));
    expect(edit.status).toBe(200);
    expect((await edit.json()).data.notes).toBe("API note");

    const sal = await patchRoute(
      req(`/api/v1/people/${personId}`, { method: "PATCH", body: { addSalaries: [{ linkId, salary: { amount: 1 } }] } }),
      params(personId),
    );
    expect(sal.status).toBe(403);

    // Same effective day as the first salary, entered later: the newer row is current.
    state.ctx = t.ctx("nuraaly", new Date("2026-11-02T08:00:00Z"));
    const ok = await patchRoute(
      req(`/api/v1/people/${personId}`, {
        method: "PATCH",
        body: { addSalaries: [{ linkId, salary: { amount: 30000, effectiveFrom: "2026-11-02" } }] },
      }),
      params(personId),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.roles[0].salary.amount).toBe(30000);

    as("talant");
    const left = await patchRoute(req(`/api/v1/people/${personId}`, { method: "PATCH", body: { status: "left" } }), params(personId));
    expect(left.status).toBe(200);
    const active = await (await listRoute(req("/api/v1/people?q=Апи"))).json();
    expect(active.data).toHaveLength(0);
    const leftList = await (await listRoute(req("/api/v1/people?q=Апи&status=left"))).json();
    expect(leftList.data).toHaveLength(1);
  });

  it("bad ids are 404, bad bodies 400", async () => {
    as("nuraaly");
    expect((await getRoute(req("/api/v1/people/nope"), params("nope"))).status).toBe(404);
    expect((await getRoute(req("/api/v1/people/x"), params("6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f"))).status).toBe(404);
    const bad = await createRoute(req("/api/v1/people", { method: "POST", body: { fullName: "" } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("validation");
    const unknown = await patchRoute(req(`/api/v1/people/${personId}`, { method: "PATCH", body: { salary: 1 } }), params(personId));
    expect(unknown.status).toBe(400);
  });
});
