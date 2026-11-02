import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

test("salary column: Nuraaly (salary viewer) sees it, Talant does not", async ({ page }) => {
  const name = `[e2e] Salary Person ${Date.now()}`;

  await login(page, "nuraaly");
  const companies = (await (await page.request.get("/api/v1/companies")).json()) as { data: { id: string; slug: string }[] };
  const kiwi = companies.data.find((c) => c.slug === "kiwi-go")!;
  const created = await page.request.post("/api/v1/people", {
    data: { fullName: name, phone: "+996 555 000 900", links: [{ companyId: kiwi.id, role: "Courier", salary: { amount: 12345 } }] },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { data: { id: string } }).data.id;

  await page.goto(`/people?q=${encodeURIComponent(name)}`);
  const row = page.locator("tr", { hasText: name });
  await expect(row).toBeVisible();
  await expect(page.getByTestId("salary-header")).toBeVisible();
  await expect(row.getByText("12 345 KGS")).toBeVisible();
  await page.goto("/companies/kiwi-go?tab=people");
  await expect(page.getByTestId("salary-header")).toBeVisible();
  await logout(page);

  await login(page, "talant");
  await page.goto(`/people?q=${encodeURIComponent(name)}`);
  await expect(page.locator("tr", { hasText: name })).toBeVisible();
  await expect(page.getByTestId("salary-header")).toHaveCount(0);
  await expect(page.getByText("12 345")).toHaveCount(0);
  await page.goto("/companies/kiwi-go?tab=people");
  await expect(page.getByTestId("people-table")).toBeVisible();
  await expect(page.getByTestId("salary-header")).toHaveCount(0);
  await page.goto(`/people/${id}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByTestId("salary-block")).toHaveCount(0);
  const api = await page.request.get(`/api/v1/people/${id}`);
  expect(api.ok()).toBeTruthy();
  const text = await api.text();
  expect(text).not.toContain("salary");
  expect(text).not.toContain("12345");
  // Salary changes through the API are refused.
  const roleId = ((await api.json()) as { data: { roles: { id: string }[] } }).data.roles[0]!.id;
  const refused = await page.request.patch(`/api/v1/people/${id}`, { data: { addSalaries: [{ linkId: roleId, salary: { amount: 1 } }] } });
  expect(refused.status()).toBe(403);
  // Settings → Access: Talant sees who has access but cannot change it.
  await page.goto("/settings");
  await expect(page.getByRole("switch", { name: "Salary access for Talant" })).toBeDisabled();

  // Clean up: mark as left (no hard delete).
  const left = await page.request.patch(`/api/v1/people/${id}`, { data: { status: "left" } });
  expect(left.ok()).toBeTruthy();
});
