import { expect, test, type Page } from "@playwright/test";
import { login, logout, openNewProjectDialog } from "./helpers";

async function createProject(page: Page, name: string) {
  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name", { exact: true })
    .fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/")[2]!;
}

async function openHistory(page: Page, projectId: string, kind: string) {
  await page.goto("/account/background-work");
  await expect(
    page.getByRole("heading", { name: "Background work", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Project", exact: true }),
  ).toContainText("All projects");
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption(projectId);
  await page
    .getByRole("combobox", { name: "Kind", exact: true })
    .selectOption(kind);
  await page
    .getByRole("combobox", { name: "View", exact: true })
    .selectOption("recent");
}

test.describe("background work", () => {
  test("a real task result remains unread across sessions and opens from the bell", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, "editor@weaver.local");
    const projectId = await createProject(page, "Background task E2E");
    await page.goto(`/projects/${projectId}/documents`);
    await page.getByRole("button", { name: "New document" }).click();
    await page.getByLabel("Title").fill("Background source");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Background source" }),
    ).toBeVisible();

    await page.goto(`/projects/${projectId}/tasks`);
    await page.getByRole("button", { name: "New task" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Background digest");
    await page.getByRole("tab", { name: "Instructions" }).click();
    await page
      .getByLabel("Instruction", { exact: true })
      .fill("Summarize what changed since the last run.");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page
      .getByRole("button", { name: "Actions for Background digest" })
      .click();
    await page.getByRole("menuitem", { name: "Run now" }).click();
    await openHistory(page, projectId, "task");
    const row = page.getByRole("row").filter({ hasText: "Background digest" });
    await expect(row.getByText("Succeeded", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(row.getByText("Unseen result", { exact: true })).toHaveCount(
      1,
    );
    await expect(
      page.getByRole("button", { name: /^Background work:.*unseen results/ }),
    ).toBeVisible();

    await logout(page);
    await login(page, "editor@weaver.local");
    await openHistory(page, projectId, "task");
    await expect(row.getByText("Unseen result", { exact: true })).toHaveCount(
      1,
    );
    await page.getByRole("button", { name: /^Background work/ }).click();
    const tray = page.getByRole("dialog", {
      name: "Background work",
      exact: true,
    });
    await expect(
      tray.getByRole("link", { name: "Background digest", exact: true }),
    ).toBeVisible();
    await expect(tray.getByText("Unseen result", { exact: true })).toHaveCount(
      0,
    );
    await tray
      .getByRole("link", { name: "Open Background digest", exact: true })
      .click();
    await expect(tray).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Background digest", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Open the report document" }).click();
    await expect(page.getByRole("note")).toContainText(
      "Maintained by scheduled task",
    );

    await openHistory(page, projectId, "task");
    await expect(row).toBeVisible();
    await expect(row.getByText("Unseen result", { exact: true })).toHaveCount(
      0,
    );
    await page.reload();
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(projectId);
    await page
      .getByRole("combobox", { name: "Kind", exact: true })
      .selectOption("task");
    await expect(row).toBeVisible();
    await expect(row.getByText("Unseen result", { exact: true })).toHaveCount(
      0,
    );
    await page
      .getByRole("combobox", { name: "Audience", exact: true })
      .selectOption("projects");
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(projectId);
    await expect(row).toBeVisible();
    await page
      .getByRole("combobox", { name: "Audience", exact: true })
      .selectOption("mine");
    await page
      .getByRole("combobox", { name: "Project", exact: true })
      .selectOption(projectId);
    await expect(row).toBeVisible();
  });

  test("the mobile tray acknowledges only its ten displayed imports and retries failed acknowledgements", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await login(page, "editor@weaver.local");
    const projectId = await createProject(page, "Background imports E2E");
    await page.goto(`/projects/${projectId}/imports`);
    await page.getByLabel("Choose files to import").setInputFiles(
      Array.from({ length: 11 }, (_, index) => ({
        name: `background-${String(index + 1).padStart(2, "0")}.md`,
        mimeType: "text/markdown",
        buffer: Buffer.from(
          `# Background ${index + 1}\n\nA ready-to-review background import.\n`,
        ),
      })),
    );
    await expect(
      page
        .getByRole("status")
        .getByText("Files uploaded. Processing will update below.", {
          exact: true,
        }),
    ).toBeVisible();
    await openHistory(page, projectId, "import");
    await expect(
      page.getByRole("table").getByText("Ready for review", { exact: true }),
    ).toHaveCount(11, { timeout: 90_000 });
    await expect(
      page.getByRole("table").getByText("Unseen result", { exact: true }),
    ).toHaveCount(11);

    let rejectAcknowledgement = true;
    await page.route("**/api/trpc/*backgroundWork.markSeen*", async (route) => {
      if (rejectAcknowledgement) await route.abort("failed");
      else await route.continue();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const bell = page.getByRole("button", { name: /^Background work/ });
    await expect(bell).toBeVisible();
    await bell.focus();
    await page.keyboard.press("Enter");
    const tray = page.getByRole("dialog", {
      name: "Background work",
      exact: true,
    });
    const recent = tray.getByRole("region", { name: "Recent results" });
    await expect(
      recent.getByRole("link", { name: /^background-\d+\.md$/ }),
    ).toHaveCount(10);
    await expect(
      tray.getByText("Couldn’t mark these results as seen.", { exact: true }),
    ).toBeVisible();
    await expect(
      recent.getByText("Unseen result", { exact: true }),
    ).toHaveCount(10);
    rejectAcknowledgement = false;
    await tray.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      recent.getByText("Unseen result", { exact: true }),
    ).toHaveCount(0);
    await expect(
      tray.getByText("Couldn’t mark these results as seen.", { exact: true }),
    ).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(tray).toBeHidden();
    await expect(bell).toBeFocused();
    await expect(
      page.getByRole("table").getByText("Unseen result", { exact: true }),
    ).toHaveCount(1);

    await page
      .getByRole("button", { name: "Mark this page as seen", exact: true })
      .click();
    await expect(
      page.getByRole("table").getByText("Unseen result", { exact: true }),
    ).toHaveCount(0);
    await bell.click();
    const importLink = recent
      .getByRole("link", { name: /^Open background-\d+\.md$/ })
      .first();
    const importTitle = (await importLink.getAttribute("aria-label"))!.replace(
      /^Open /,
      "",
    );
    await importLink.click();
    await expect(tray).toBeHidden();
    await expect(
      page.getByRole("heading", { name: `Review ${importTitle}`, exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Draft preview")).toContainText(
      "A ready-to-review background import.",
    );
  });

  test("failed list reads show Retry and recover without treating an error as empty work", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, "editor@weaver.local");
    const projectId = await createProject(page, "Background retry E2E");
    await page.goto(`/projects/${projectId}/imports`);
    await page.getByLabel("Choose files to import").setInputFiles({
      name: "background-retry.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "# Retry\n\nThis result survives a failed refresh.\n",
      ),
    });
    await expect(
      page.getByRole("link", {
        name: "Review background-retry.md",
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    await openHistory(page, projectId, "import");
    const row = page
      .getByRole("row")
      .filter({ hasText: "background-retry.md" });
    await expect(
      row.getByText("Ready for review", { exact: true }),
    ).toBeVisible();
    let unavailable = true;
    await page.route("**/api/trpc/*backgroundWork.list*", async (route) => {
      if (unavailable) await route.abort("failed");
      else await route.continue();
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByText("Background work is unavailable.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No background work matches these filters.", {
        exact: true,
      }),
    ).toBeHidden();
    unavailable = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByText("Background work is unavailable.", { exact: true }),
    ).toBeHidden();
    await expect(
      row.getByText("Ready for review", { exact: true }),
    ).toBeVisible();
  });
});
