import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

/** Settings → Access (as a salary viewer): Talant's salary switch on or off. */
async function setTalantSalaryAccess(page: Page, on: boolean) {
  await page.goto("/settings");
  const sw = page.getByRole("switch", { name: "Salary access for Talant" });
  if ((await sw.getAttribute("aria-checked")) !== String(on)) {
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", String(on));
  }
}

test("salary column: both founders see it by default; switched off, Talant does not", async ({ page }) => {
  const name = `[e2e] Salary Person ${Date.now()}`;

  await login(page, "nuraaly");
  // Default (the founders' decision): both founders see salaries.
  await page.goto("/settings");
  await expect(page.getByRole("switch", { name: "Salary access for Talant" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Salary access for Nuraaly" })).toHaveAttribute("aria-checked", "true");
  // The rest of the test is about a founder WITHOUT salary access: switch Talant off.
  await setTalantSalaryAccess(page, false);
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
  // Sanity for the raw-payload check below: the viewer's HTML does contain the amount.
  const viewerHtml = await (await page.request.get(`/people?q=${encodeURIComponent(name)}`)).text();
  expect(viewerHtml).toMatch(/12[\s\u00a0\u202f]?345/);
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
  // The raw server responses for Talant (HTML and the React Server Components payload of
  // client navigations) carry no salary amount anywhere, not just in visible text.
  for (const url of [`/people?q=${encodeURIComponent(name)}`, `/people/${id}`, "/companies/kiwi-go?tab=people", "/people"]) {
    for (const headers of [{}, { RSC: "1" }] as Record<string, string>[]) {
      const res = await page.request.get(url, { headers });
      expect(res.ok(), `${url} ${JSON.stringify(headers)}`).toBeTruthy();
      const raw = await res.text();
      const shortName = name.replace("[e2e] ", "");
      expect(raw, `${url} ${JSON.stringify(headers)}`).toContain(shortName);
      const body = raw.split(shortName).join(""); // the name carries a timestamp
      expect(body).not.toMatch(/12[\s\u00a0\u202f]?345/);
      expect(body).not.toContain("salaryHistory");
    }
  }
  // Salary changes through the API are refused.
  const roleId = ((await api.json()) as { data: { roles: { id: string }[] } }).data.roles[0]!.id;
  const refused = await page.request.patch(`/api/v1/people/${id}`, { data: { addSalaries: [{ linkId: roleId, salary: { amount: 1 } }] } });
  expect(refused.status()).toBe(403);
  // Settings → Access: Talant sees who has access but cannot change it.
  await page.goto("/settings");
  await expect(page.getByRole("switch", { name: "Salary access for Talant" })).toBeDisabled();

  // Clean up: mark as left (no hard delete), and give Talant his salary access back.
  const left = await page.request.patch(`/api/v1/people/${id}`, { data: { status: "left" } });
  expect(left.ok()).toBeTruthy();
  await logout(page);
  await login(page, "nuraaly");
  await setTalantSalaryAccess(page, true);
});

test("import wizard: preview then confirm (the previewed file's hash is sent back)", async ({ page }) => {
  const stamp = Date.now();
  const csv = `ФИО,Компания,Должность,Телефон\n[e2e] Импорт ${stamp},Kiwi Go,Courier,+996 555 ${String(stamp).slice(-6, -3)} ${String(stamp).slice(-3)}\n`;
  await login(page, "nuraaly");
  await page.goto("/people/import");
  const form = page.getByRole("form", { name: "Import people" });
  await form.getByLabel("Spreadsheet file").setInputFiles({ name: "e2e.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await form.getByRole("button", { name: "Read file" }).click();
  await form.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("import-preview")).toContainText(`[e2e] Импорт ${stamp}`);
  await form.getByRole("button", { name: "Import 1 rows" }).click();
  await expect(page.getByRole("status")).toContainText("1 rows applied");

  // Clean up: mark as left.
  const found = (await (await page.request.get(`/api/v1/people?q=${encodeURIComponent(`Импорт ${stamp}`)}`)).json()) as { data: { id: string }[] };
  expect(found.data).toHaveLength(1);
  expect((await page.request.patch(`/api/v1/people/${found.data[0]!.id}`, { data: { status: "left" } })).ok()).toBeTruthy();
});
