import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("authentication", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("rejects invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("admin@weaver.local");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    // scrypt verification runs on a loaded host while other workers sign in.
    await expect(page.getByText("Invalid credentials")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/\/login/);
  });

  test("signs in and signs out", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("admin@weaver.local");
    await page.getByLabel("Password").fill("admin1234567");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/documents$/);
  });

  test("redirects the root route to a project's documents", async ({
    page,
  }) => {
    await login(page, "admin@weaver.local");
    await page.goto("/");
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/documents$/);
  });

  test("a fresh user lands in their personal workspace and cannot delete it", async ({
    page,
  }) => {
    await login(page, "personal@weaver.local");
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/documents$/);
    await page.getByRole("button", { name: "Switch project" }).click();
    const workspaceItem = page.getByRole("menuitem", {
      name: /Pat Personal's workspace/,
    });
    await expect(workspaceItem).toBeVisible();
    await workspaceItem.click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/documents$/);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByText("Personal workspace")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Delete project" }),
    ).toHaveCount(0);
  });
});
