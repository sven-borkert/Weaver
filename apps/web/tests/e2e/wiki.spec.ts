import { expect, test } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";

test.describe("wiki agent", () => {
  test("a note and a file become pages, the Runs tab shows usage, and Revert restores", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await login(page, "owner@weaver.local");
    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill("Wiki E2E");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Wiki E2E" })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/")[2]!;

    await page.goto(`/projects/${projectId}/settings`);
    await page.getByTestId("wiki-enable").click();
    await expect(page.getByText("Wiki agent enabled")).toBeVisible();

    await page.goto(`/projects/${projectId}/wiki`);
    await page.getByRole("textbox").first().fill("Meeting notes for the wiki.");
    await page.getByRole("button", { name: "Add to queue" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "e2e-wiki-input.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Vendor contract\n\nThe term is three years.\n"),
    });
    const queue = page.getByRole("region", { name: "Queue" });
    await expect(queue.getByText("e2e-wiki-input.md")).toBeVisible();

    await page.getByRole("button", { name: /^Process all/ }).click();
    // The tick prepares sources, then the worker runs the mock agent to finish_run.
    await expect(queue.getByText("e2e-wiki-input.md")).toBeHidden({
      timeout: 180_000,
    });

    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await expect(page.getByText("ingest · manual")).toBeVisible();
    await expect(page.getByText("Succeeded")).toBeVisible();
    await expect(page.getByText("2 created")).toBeVisible();
    await expect(page.getByText(/\d[\d,]* tokens/).first()).toBeVisible();

    await page.getByRole("button", { name: "ingest · manual" }).click();
    const drawer = page.getByRole("dialog", { name: "Wiki run" });
    await expect(
      drawer.getByText("written by the agent").first(),
    ).toBeVisible();
    await expect(drawer.getByText("Wiki agent").first()).toBeVisible();
    await drawer.getByRole("button", { name: "Revert run" }).click();
    await page
      .getByRole("dialog", { name: "Revert this run?" })
      .getByRole("button", { name: "Revert run" })
      .click();
    await page.keyboard.press("Escape");

    await expect(page.getByText("revert · manual")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Succeeded")).toHaveCount(2, {
      timeout: 120_000,
    });
    await page.goto(`/projects/${projectId}/wiki`);
    await expect(
      page
        .getByRole("region", { name: "Needs attention" })
        .getByText("Reverted"),
    ).toHaveCount(2);
  });

  test("Run maintenance now writes a lint report and the Runs tab shows it", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await login(page, "owner@weaver.local");
    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill("Wiki Lint E2E");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Wiki Lint E2E" }),
    ).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/")[2]!;

    await page.goto(`/projects/${projectId}/settings`);
    await page.getByTestId("wiki-enable").click();
    await expect(page.getByText("Wiki agent enabled")).toBeVisible();
    await expect(page.getByText("Scheduled maintenance is off.")).toBeVisible();

    await page.goto(`/projects/${projectId}/wiki/runs`);
    await page.getByRole("button", { name: "Run maintenance now" }).click();
    await expect(page.getByText("lint · manual")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Succeeded")).toBeVisible({ timeout: 180_000 });
    // A second press within the hour is refused with a clear message.
    await page.getByRole("button", { name: "Run maintenance now" }).click();
    await expect(page.getByText(/less than an hour ago/)).toBeVisible();
  });
});
