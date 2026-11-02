import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { ServiceContext } from "@/server/services/context";
import { LocalFileStorage, setFileStorageForTests } from "@/server/storage/file-storage";
import { createTestDb, type TestDb } from "../helpers/db";

const state = vi.hoisted(() => ({ ctx: null as ServiceContext | null }));
vi.mock("@/server/context", () => ({
  getApiContext: async () => state.ctx,
  getPageContext: async () => state.ctx,
}));

const { POST: upload } = await import("@/app/api/v1/holding/files/route");
const { GET: download } = await import("@/app/api/v1/holding/files/[id]/route");
const { GET: actsRoute, PATCH: patchActsRoute } = await import("@/app/api/v1/holding/acts/route");
const { GET: debtsRoute, POST: addDebtRoute } = await import("@/app/api/v1/holding/debts/route");
const { GET: contractsRoute, POST: addContractRoute } = await import("@/app/api/v1/holding/contracts/route");
const { POST: askedRoute } = await import("@/app/api/v1/holding/asked/route");

let t: TestDb;
let dir: string;
beforeAll(async () => {
  t = await createTestDb({ now: new Date("2026-11-20T06:00:00Z") });
  dir = mkdtempSync(path.join(os.tmpdir(), "holding-files-"));
  setFileStorageForTests(new LocalFileStorage(dir));
});
afterAll(async () => {
  setFileStorageForTests(null);
  rmSync(dir, { recursive: true, force: true });
  await t.handle.close();
});

const as = (who: "nuraaly" | "talant" | "staff" | null) => {
  state.ctx =
    who === null ? null : who === "staff" ? { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" } } : t.ctx(who);
};

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\ntrailer\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function uploadReq(bytes: Uint8Array, name: string, type = "application/pdf") {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name, { type }));
  return new NextRequest("http://localhost/api/v1/holding/files", { method: "POST", body: fd });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("holding documents: upload and download", () => {
  let fileId: string;

  it("refuses an unauthenticated upload and download (401), and staff (403)", async () => {
    as(null);
    expect((await upload(uploadReq(PDF, "act.pdf"))).status).toBe(401);
    expect((await download(new NextRequest("http://localhost/x"), params("00000000-0000-4000-8000-000000000000"))).status).toBe(401);
    as("staff");
    expect((await upload(uploadReq(PDF, "act.pdf"))).status).toBe(403);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses the wrong type (by content, not by name) and oversize files", async () => {
    as("nuraaly");
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const fake = await upload(uploadReq(html, "act.pdf", "application/pdf"));
    expect(fake.status).toBe(415);
    expect((await fake.json()).error.message).toMatch(/PDF, JPG or PNG/);
    const exe = await upload(uploadReq(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "scan.png", "image/png"));
    expect(exe.status).toBe(415);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    const tooBig = await upload(uploadReq(big, "big.pdf"));
    expect(tooBig.status).toBe(413);
    const empty = await upload(uploadReq(new Uint8Array(), "empty.pdf"));
    expect(empty.status).toBe(400);
    const notMultipart = await upload(jsonReq("/api/v1/holding/files", "POST", { file: "x" }) as NextRequest);
    expect(notMultipart.status).toBe(415);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stores a PDF (exactly 10 MB is fine) and serves it only to founders, with nosniff", async () => {
    as("nuraaly");
    const res = await upload(uploadReq(PDF, "../../Акт сентябрь.pdf"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string; contentType: string } };
    expect(body.data).toMatchObject({ name: "Акт сентябрь.pdf", contentType: "application/pdf" });
    fileId = body.data.id;
    const max = new Uint8Array(10 * 1024 * 1024);
    max.set(PNG);
    expect((await upload(uploadReq(max, "scan.png", "image/png"))).status).toBe(201);

    as("talant");
    const got = await download(new NextRequest("http://localhost/x"), params(fileId));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cache-control")).toContain("no-store");
    expect(got.headers.get("content-disposition")).toContain("filename*=UTF-8''%D0%90%D0%BA%D1%82");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PDF);

    as(null);
    expect((await download(new NextRequest("http://localhost/x"), params(fileId))).status).toBe(401);
    as("staff");
    expect((await download(new NextRequest("http://localhost/x"), params(fileId))).status).toBe(403);
    as("nuraaly");
    expect((await download(new NextRequest("http://localhost/x"), params("not-an-id"))).status).toBe(404);
    expect((await download(new NextRequest("http://localhost/x"), params("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });

  it("attaches the file to an акт and a contract through the REST API", async () => {
    as("nuraaly");
    const grid = (await (await actsRoute()).json()) as { data: { rows: { flow: { id: string; label: string } }[] } };
    const flowId = grid.data.rows.find((r) => r.flow.label === "Alura Style → Alura Brand")!.flow.id;
    // No start date yet: set one through the service so October is expected.
    const { updateFlow } = await import("@/server/services/holding");
    await updateFlow(t.ctx("nuraaly"), flowId, { since: "2026-09-01" });
    const res = await patchActsRoute(jsonReq("/api/v1/holding/acts", "PATCH", { flowId, period: "2026-10", status: "received", amount: 120000, attachmentFileId: fileId }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ state: "received", tone: "ok", attachment: { id: fileId } });
    const bad = await patchActsRoute(jsonReq("/api/v1/holding/acts", "PATCH", { flowId, period: "2026-10", status: "lost" }));
    expect(bad.status).toBe(400);

    const c = await addContractRoute(jsonReq("/api/v1/holding/contracts", "POST", { flowId, number: "№ 3", status: "signed", validUntil: "2026-12-01", attachmentFileId: fileId }));
    expect(c.status).toBe(201);
    expect((await c.json()).data).toMatchObject({ warning: { kind: "expiring", days: 11 }, attachment: { id: fileId } });
    const list = await (await contractsRoute(jsonReq("/api/v1/holding/contracts", "GET"))).json();
    expect(list.data).toHaveLength(1);

    const pay = await addDebtRoute(
      jsonReq("/api/v1/holding/debts", "POST", { kind: "payment", debtorCompanyId: t.companyIds["alura-brand"], creditorCompanyId: t.companyIds["alura-style"], entryDate: "2026-11-05", amount: "20000" }),
    );
    expect(pay.status).toBe(201);
    const debts = await (await debtsRoute(jsonReq("/api/v1/holding/debts", "GET"))).json();
    expect(debts.data).toMatchObject({ total: 100000, pairs: [{ debtor: { slug: "alura-brand" }, creditor: { slug: "alura-style" }, amount: 100000 }] });
    expect((await debtsRoute(jsonReq("/api/v1/holding/debts?asOf=yesterday", "GET"))).status).toBe(400);

    // September is missing: "I asked Elmurat" through the API.
    const asked = await askedRoute(jsonReq("/api/v1/holding/asked", "POST", { cells: [{ flowId, period: "2026-09" }] }));
    expect((await asked.json()).data).toEqual({ changed: 1 });
    as(null);
    expect((await actsRoute()).status).toBe(401);
  });
});
