import { expect, test } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";

test.describe("projects", () => {
  test("create project, then manage a member", async ({ page }) => {
    await login(page, "owner@weaver.local");

    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill("E2E Project");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(
      page.getByRole("heading", { name: "E2E Project" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add member" }).click();
    await page.getByLabel("Email").fill("editor@weaver.local");
    // exact: the substring "Add" also matches the "Add member" trigger.
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      page.getByRole("row").filter({ hasText: "editor@weaver.local" }),
    ).toBeVisible();
  });

  test("switches projects from the header and keeps the section", async ({
    page,
  }) => {
    await login(page, "owner@weaver.local");
    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill("Switcher Source E2E");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
    // Captured so the post-switch assertion targets this exact project — a
    // generic /projects\/[0-9a-f-]{36}\/tables$ pattern would already match
    // the target project's current URL and resolve before the switch lands.
    const sourceId = /\/projects\/([0-9a-f-]{36})\/settings$/.exec(
      page.url(),
    )![1];
    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill("Switcher Target E2E");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/settings$/);
    await page
      .getByRole("list", { name: "Switcher Target E2E sections" })
      .getByRole("link", { name: "Tables", exact: true })
      .click();
    await page.getByRole("button", { name: "Switch project" }).click();
    await page.getByRole("menuitem", { name: "Switcher Source E2E" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${sourceId}/tables$`));
    await page.getByRole("button", { name: "Switch project" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Switcher Source E2E" }),
    ).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
  });
});
