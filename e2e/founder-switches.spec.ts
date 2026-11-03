import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 26" for the month `n` months before the current Bishkek month. */
function monthShort(n: number): string {
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bishkek", year: "numeric", month: "2-digit" }).format(new Date());
  let y = Number(ym.slice(0, 4));
  let m = Number(ym.slice(5, 7)) - n;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${SHORT[m - 1]} ${String(y).slice(2)}`;
}

test("Settings → Overdue tasks: the default is one grouped push; another style is saved", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/settings");
  const separate = page.getByRole("radio", { name: /One push per task/ });
  const grouped = page.getByRole("radio", { name: /One grouped push \(default\)/ });
  await expect(page.getByRole("radio", { name: /Morning summary only/ })).toBeVisible();
  if (!(await grouped.isChecked())) {
    await grouped.check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  }
  await separate.check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: /One push per task/ })).toBeChecked();
  // Back to the default for the other tests.
  await page.getByRole("radio", { name: /One grouped push/ }).check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});

test("Numbers → Daily: a month average entered under Month totals is kept apart from the days", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/companies/kiwi-go?tab=numbers&g=day");
  const form = page.getByRole("form", { name: "Month totals" });
  await expect(form).toBeVisible();
  const cell = form.getByLabel(`On-time delivery · month average, ${monthShort(3)}`);
  // The e2e database is kept between runs: always enter a different value (latest wins).
  const value = (await cell.inputValue()) === "93.25" ? "93.75" : "93.25";
  await cell.fill(value);
  await form.getByRole("button", { name: /^Save/ }).click();
  await expect(form.getByText("Saved:")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("form", { name: "Month totals" }).getByLabel(`On-time delivery · month average, ${monthShort(3)}`)).toHaveValue(value);
  await expect(page.getByTestId("numbers-grid")).not.toContainText(value);
});

test("Settings → setup cards: Connect Telegram names what is missing; the reminder clock explains the local database", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/settings");
  // e2e runs without APP_URL and without a bot token (nothing ever reaches Telegram).
  const tg = page.getByTestId("telegram-setup");
  await expect(tg.getByTestId("telegram-setup-missing")).toContainText("APP_URL, TELEGRAM_BOT_TOKEN");
  await expect(tg.getByRole("button", { name: "Connect Telegram" })).toBeDisabled();
  const clock = page.getByTestId("reminder-clock");
  await expect(clock.getByTestId("reminder-clock-missing")).toContainText("APP_URL");
  await expect(clock.getByRole("button", { name: "Start reminder clock" })).toBeDisabled();
  await clock.getByRole("button", { name: "Check status" }).click();
  await expect(clock.getByTestId("reminder-clock-result")).toContainText("This database has no pg_cron, pg_net");
  await expect(clock.getByTestId("reminder-clock-result")).toContainText("cron-job.org");
});
