import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("holding: mark a missing акт as requested → the cell turns yellow", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/holding");
  await expect(page.getByRole("heading", { name: "Holding" })).toBeVisible();
  await expect(page.getByTestId("acts-grid")).toBeVisible();

  const missing = page.locator('[data-testid="act-cell"][data-cell-state="missing"]').first();
  await expect(missing).toBeVisible();
  const flow = await missing.locator("xpath=ancestor::tr").getAttribute("data-flow");
  const period = await missing.getAttribute("data-period");
  await missing.click();

  const panel = page.getByTestId("act-panel");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Requested (asked Elmurat)").check();
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel).toBeHidden();

  const cell = page.locator(`tr[data-flow="${flow}"] [data-testid="act-cell"][data-period="${period}"]`);
  await expect(cell).toHaveAttribute("data-cell-state", "requested");
  await expect(cell).toHaveClass(/bg-warn-soft/);

  // The REST API agrees (what the iOS app will use).
  const api = await page.request.get("/api/v1/holding/acts");
  const grid = (await api.json()) as { data: { rows: { flow: { label: string }; cells: { period: string; state: string; requestedBy: string | null }[] }[] } };
  const c = grid.data.rows.find((r) => r.flow.label === flow)!.cells.find((x) => x.period === period)!;
  expect(c).toMatchObject({ state: "requested", requestedBy: "Nuraaly" });
});

test("holding: attach a scan to an акт (upload through the browser, served back to the founder)", async ({ page }) => {
  await login(page, "talant");
  await page.goto("/holding");
  const cell = page.locator('[data-testid="act-cell"][data-cell-state="missing"]').first();
  const flow = await cell.locator("xpath=ancestor::tr").getAttribute("data-flow");
  const period = await cell.getAttribute("data-period");
  const totalNow = async () => ((await (await page.request.get("/api/v1/holding/debts")).json()) as { data: { total: number } }).data.total;
  const before = await totalNow();
  await cell.click();
  const panel = page.getByTestId("act-panel");
  await panel.getByLabel("Received").check();
  await panel.getByLabel("Amount (KGS, optional)").fill("125000");
  await panel.getByLabel("Attach a scan").setInputFiles({ name: "akt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  const link = panel.getByRole("link", { name: "akt.pdf" });
  await expect(link).toBeVisible();
  const file = await page.request.get((await link.getAttribute("href"))!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("application/pdf");
  expect(file.headers()["x-content-type-options"]).toBe("nosniff");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel).toBeHidden();
  const saved = page.locator(`tr[data-flow="${flow}"] [data-testid="act-cell"][data-period="${period}"]`);
  await expect(saved).toHaveAttribute("data-cell-state", "received");
  // The received amount now counts as owed (debts are derived from the акты).
  expect(await totalNow()).toBe(before + 125000);
  await expect(page.getByTestId("debts-total")).toBeVisible();

  // A wrong file type is refused with a clear message.
  await page.locator('[data-testid="act-cell"][data-cell-state="missing"]').first().click();
  await panel.getByLabel("Attach a scan").setInputFiles({ name: "evil.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html></html>") });
  await expect(panel.getByRole("alert")).toContainText("Only PDF, JPG or PNG");
});

test("holding documents are not served without signing in", async ({ request }) => {
  const res = await request.get("/api/v1/holding/files/00000000-0000-4000-8000-000000000000");
  expect(res.status()).toBe(401);
});
