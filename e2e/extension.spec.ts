import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

test("Settings → Browser extension: create a key (shown once) → the extension posts numbers → the call is logged → revoke", async ({ page, playwright, baseURL }) => {
  await login(page, "nuraaly");
  await page.goto("/settings");
  const card = page.getByTestId("extension-card");
  const name = `e2e key ${Date.now().toString(36)}`;
  await card.getByLabel("Key name").fill(name);
  await card.getByRole("button", { name: "Create key" }).click();
  const shown = card.getByTestId("new-extension-key-value");
  await expect(shown).toHaveText(/^fcx_/);
  const key = (await shown.textContent())!.trim();
  await expect(card.getByTestId("extension-key").filter({ hasText: name })).toContainText("never used");

  // The extension: no session cookie, a chrome-extension origin, a bearer key.
  const api = await playwright.request.newContext({ baseURL });
  const pre = await api.fetch("/api/v1/ingest", { method: "OPTIONS", headers: { origin: EXT, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
  expect(pre.status()).toBe(204);
  expect(pre.headers()["access-control-allow-origin"]).toBe(EXT);
  const res = await api.post("/api/v1/ingest", {
    headers: { origin: EXT, authorization: `Bearer ${key}`, "content-type": "application/json" },
    data: { source: "extension", adapterId: "e2e-adapter", points: [{ companySlug: "kiwi-go", metricKey: "orders_day", periodStart: "2026-01-05", value: "140" }, { companySlug: "nope", metricKey: "x", periodStart: "2026-01-05", value: "1" }] },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()["access-control-allow-origin"]).toBe(EXT);
  expect(await res.json()).toEqual({ accepted: 1, rejected: [{ index: 1, reason: "Unknown company: nope" }] });
  expect((await api.post("/api/v1/ingest", { headers: { authorization: "Bearer fcx_wrong" }, data: { source: "extension", adapterId: "a", points: [] } })).status()).toBe(401);

  await page.reload();
  await expect(page.getByTestId("ingest-log")).toContainText("e2e-adapter");
  await expect(page.getByTestId("ingest-log")).toContainText("1 accepted · 1 rejected");
  const row = card.getByTestId("extension-key").filter({ hasText: name });
  await expect(row).toContainText("last used");
  await row.getByRole("button", { name: `Revoke ${name}` }).click();
  await expect(row).toContainText("Revoked");
  expect((await api.post("/api/v1/ingest", { headers: { authorization: `Bearer ${key}` }, data: { source: "extension", adapterId: "a", points: [] } })).status()).toBe(401);
  await api.dispose();
});
