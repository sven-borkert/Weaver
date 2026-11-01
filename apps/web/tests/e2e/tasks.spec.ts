import { expect, test } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";

test.describe("scheduled tasks", () => {
  test("an Editor creates a task, runs it now, and the report document appears with its banner", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, "owner@weaver.local");
    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill("Tasks E2E");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Tasks E2E" }),
    ).toBeVisible();
    const projectUrl = new URL(page.url());
    const projectId = projectUrl.pathname.split("/")[2]!;

    // Something for the digest to see.
    await page.goto(`/projects/${projectId}/documents`);
    await page.getByRole("button", { name: "New document" }).click();
    await page.getByLabel("Title").fill("Runbook");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Runbook" })).toBeVisible();

    await page.goto(`/projects/${projectId}/tasks`);
    await page.getByRole("button", { name: "New task" }).click();
    await page.getByLabel("Name").fill("Daily digest");
    await page.getByRole("tab", { name: "Instructions" }).click();
    await page
      .getByLabel("Instruction", { exact: true })
      .fill("Summarize what changed since the last run.");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Daily digest" }),
    ).toBeVisible();
    await expect(page.getByText("Daily at 07:00")).toBeVisible();

    await page
      .getByRole("button", { name: "Actions for Daily digest" })
      .click();
    await page.getByRole("menuitem", { name: "Run now" }).click();
    await page.getByRole("link", { name: "Daily digest" }).click();
    await expect(
      page.getByRole("heading", { name: "Daily digest" }),
    ).toBeVisible();
    // The worker leases, calls the mock provider, and writes the document.
    await expect(page.getByText("Succeeded")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("link", { name: "Open the report document" }).click();
    await expect(
      page.getByRole("heading", { name: "Daily digest" }),
    ).toBeVisible();
    await expect(
      page
        .getByLabel("Document content")
        .getByText("Generated for the e2e scheduled task"),
    ).toBeVisible();
    await expect(page.getByRole("note")).toContainText(
      "Maintained by scheduled task",
    );
  });
});
