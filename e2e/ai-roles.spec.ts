import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/** Today in Asia/Bishkek (the app's business day). */
function bishkekToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bishkek", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function addMonths(ym: string, n: number): string {
  let y = Number(ym.slice(0, 4));
  let m = Number(ym.slice(5, 7)) + n;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}
function daysOf(ym: string): string[] {
  const n = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
}

async function metricIds(page: Page): Promise<Record<string, string>> {
  const res = await page.request.get("/api/v1/companies/kiwi-go/metrics");
  const data = ((await res.json()) as { data: { id: string; key: string }[] }).data;
  return Object.fromEntries(data.map((m) => [m.key, m.id]));
}

test("hire the Financial Analyst for Kiwi Go → enter last month's numbers → run → the report shows findings", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const lastMonth = addMonths(bishkekToday().slice(0, 7), -1);
  const prevMonth = addMonths(lastMonth, -1);
  const label = `${LONG[Number(lastMonth.slice(5, 7)) - 1]} ${lastMonth.slice(0, 4)}`;
  await login(page, "nuraaly");

  // 1. Hire (or, when an earlier run already hired it, tune) through the wizard.
  await page.goto("/ai-roles");
  await expect(page.getByTestId("ai-provider-status")).toContainText("AI provider: not chosen yet");
  await expect(page.locator('[data-testid="role-template"][data-role="hr"]')).toContainText("Coming soon");
  const card = page.locator('[data-testid="hire-card"][data-company="kiwi-go"][data-role="financial-analyst"]');
  if (await card.count()) {
    await card.getByRole("button", { name: "Tune" }).click();
    const dialog = page.getByRole("dialog", { name: "Tune Financial Analyst" });
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    if ((await card.getByRole("button", { name: "Resume" }).count()) > 0) await card.getByRole("button", { name: "Resume" }).click();
  } else {
    await page.getByRole("button", { name: "Hire Financial Analyst" }).click();
    const dialog = page.getByRole("dialog", { name: "Hire Financial Analyst" });
    await dialog.getByRole("radio", { name: /Kiwi Go/ }).check();
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByRole("checkbox", { name: /COD collected/ })).toBeChecked();
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByLabel("Day of the month")).toHaveValue("10");
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByRole("checkbox", { name: "Reports to Talant" })).toBeChecked();
    await dialog.getByRole("button", { name: "Hire Financial Analyst" }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(card).toContainText("Monthly on the 10th");
  await expect(card).toContainText("Active");

  // 2. Last month's numbers: revenue in the Numbers grid (UI), daily numbers through the REST API.
  await page.goto("/companies/kiwi-go?tab=numbers&g=month");
  const short = (ym: string) => `${SHORT[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
  await page.getByLabel(`Revenue, ${short(prevMonth)}`).fill("1200000");
  await page.getByLabel(`Revenue, ${short(lastMonth)}`).fill("810000");
  const save = page.getByRole("button", { name: /^Save/ });
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText("Saved:")).toBeVisible();
  }
  const ids = await metricIds(page);
  const origin = new URL(baseURL!).origin;
  for (const [key, value] of [["orders_day", "100"], ["cod_collected", "30000"], ["cod_paid_out", "10000"]] as const) {
    for (const day of daysOf(lastMonth)) {
      const res = await page.request.post(`/api/v1/metrics/${ids[key]}/values`, { headers: { origin }, data: { period: day, value } });
      expect(res.status(), `${key} ${day}`).toBeLessThan(300);
    }
  }

  // 3. Run now → the report.
  await page.goto("/ai-roles");
  await card.getByRole("button", { name: "Run now (last month)" }).click();
  await page.waitForURL(/\/ai-roles\/runs\//);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`Financial Analyst · Kiwi Go · ${label}`);
  await expect(page.getByText("Reported", { exact: true })).toBeVisible();
  const risks = page.getByTestId("findings-risk");
  await expect(risks).toContainText("Only 33.3% of COD collected");
  await expect(risks.getByRole("button", { name: "Create task" }).or(risks.getByText("Task created"))).toBeVisible();
  await expect(page.getByTestId("findings-warn")).toContainText("Revenue fell 32.5% vs");
  await expect(page.getByTestId("ai-summary")).toContainText("AI summary appears after the AI provider is chosen");
  await expect(page.getByRole("table")).toContainText("COD collected");

  // 4. The report is also in the company's AI roles tab and the agent panel.
  await page.goto("/companies/kiwi-go?tab=ai");
  await expect(page.getByTestId("company-hire").filter({ hasText: "Financial Analyst" })).toContainText(label);
  await page.getByRole("button", { name: "Agent" }).click();
  await expect(page.getByRole("complementary", { name: "Agent panel" }).getByTestId("agent-hire").first()).toContainText("Financial Analyst");
});
