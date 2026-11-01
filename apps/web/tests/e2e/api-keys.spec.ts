import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("personal API keys", () => {
  test("creates a key, reveals it once, and revokes it", async ({ page }) => {
    await login(page, "owner@weaver.local");
    await page.getByRole("button", { name: "User menu" }).first().click();
    await page.getByRole("menuitem", { name: "API keys" }).click();
    await expect(page).toHaveURL(/\/account\/api-keys$/);
    await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByLabel("Name").fill("Playwright key");
    await page.getByLabel("Edit content directly, without review").check();
    await page
      .getByLabel("Submit files to Imports from external systems")
      .check();
    await page.getByRole("button", { name: "Create", exact: true }).click();

    const secret = page.getByRole("textbox", { name: "New API key" });
    await expect(secret).toHaveValue(/^wvr_[A-Za-z0-9_-]{20,}$/);
    const shown = await secret.inputValue();
    await page.getByRole("button", { name: "I have copied the key" }).click();

    const row = page.getByRole("row", { name: /Playwright key/ });
    await expect(row).toBeVisible();
    await expect(row.getByText("Write")).toBeVisible();
    await expect(row.getByText("Import")).toBeVisible();
    await expect(page.getByText(shown)).toHaveCount(0);

    await row.getByRole("button", { name: "Revoke Playwright key" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByRole("row", { name: /Playwright key/ })).toHaveCount(
      0,
    );
    await expect(page.getByText("You have no API keys yet.")).toBeVisible();
  });
});
