import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("shortcuts: ? opens the dialog, Esc closes and gives focus back; / focuses search; no keys while typing", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search" });
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });

  // Typing "?" in a field types it, nothing opens.
  await search.click();
  await page.keyboard.type("a?");
  await expect(search).toHaveValue("a?");
  await expect(dialog).toHaveCount(0);
  await search.fill("");

  // From the trigger button: focus moves into the dialog, Tab stays inside, Esc returns focus.
  const trigger = page.getByRole("button", { name: "Keyboard shortcuts" });
  await trigger.focus();
  await page.keyboard.press("Shift+Slash"); // "?"
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // "/" focuses search (and is not typed into it).
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("Slash");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
});

test("theme: Dark is applied, kept across reload (set before paint), System clears it", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/settings");
  const group = page.getByRole("group", { name: "Theme" });
  await group.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(group.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");

  // The inline head script sets it before React runs: present in the first DOM we can see.
  await page.reload({ waitUntil: "domcontentloaded" });
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");

  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  expect(await page.evaluate(() => localStorage.getItem("fc-theme"))).toBeNull();
});
