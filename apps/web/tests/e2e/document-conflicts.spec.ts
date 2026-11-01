import { expect, test, type Page } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";
import { saveDocument } from "./document-helpers";

async function createSharedDocument(page: Page, projectName: string) {
  await login(page, "owner@weaver.local");
  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill(projectName);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await page.getByRole("button", { name: "Add member" }).click();
  const member = page.getByRole("dialog", { name: "Add member" });
  await member.getByLabel("Email").fill("editor@weaver.local");
  await member.getByLabel("Role").click();
  await page.getByRole("option", { name: "Editor", exact: true }).click();
  await member.getByRole("button", { name: "Add", exact: true }).click();
  await expect(member).toBeHidden();
  await page
    .getByRole("list", { name: `${projectName} sections` })
    .getByRole("link", { name: "Documents", exact: true })
    .click();
  await page.getByRole("button", { name: "New document" }).click();
  const create = page.getByRole("dialog", { name: "New document" });
  await create.getByLabel("Title").fill("Shared document");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document content" })
    .fill("Original saved body");
  await saveDocument(page);
  return page.url();
}

async function replaceDraft(page: Page, title: string, body: string) {
  await page.getByRole("textbox", { name: "Document title" }).fill(title);
  await page.getByRole("textbox", { name: "Document content" }).fill(body);
  await expect(
    page.getByRole("button", { name: "Save document", exact: true }),
  ).toBeEnabled();
}

async function refreshMembershipOnReturn(page: Page) {
  // Advance the shared query cache's 30-second stale window before returning to the tab.
  await page.clock.install();
  await page.clock.fastForward(31_000);
  await page.bringToFront();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("visibilitychange")),
  );
}

test("concurrent document saves keep drafts and offer overwrite or reload", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const url = await createSharedDocument(page, "Document conflicts E2E");
  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await login(second, "editor@weaver.local");
    await second.goto(url);
    const firstBody = page.getByRole("textbox", {
      name: "Document content",
      includeHidden: true,
    });
    const firstTitle = page.getByRole("textbox", { name: "Document title" });
    const save = page.getByRole("button", {
      name: "Save document",
      exact: true,
    });
    const conflict = page.getByRole("dialog", {
      name: "This document changed elsewhere",
    });
    await expect(
      second.getByRole("textbox", { name: "Document content" }),
    ).toHaveText("Original saved body");
    const originalCanvas = await firstBody.elementHandle();

    await firstTitle.fill("Owner draft");
    await page
      .getByRole("button", { name: "View Markdown source", exact: true })
      .click();
    const firstSource = page.getByRole("textbox", {
      name: "Document Markdown source",
      exact: true,
    });
    await firstSource.fill("**Owner text awaiting save**\n");
    await expect(save).toBeEnabled();
    await replaceDraft(
      second,
      "Saved elsewhere",
      "A different member saved this text",
    );
    await saveDocument(second);
    await save.click();
    await expect(conflict).toBeVisible();
    await conflict
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await expect(conflict).toBeHidden();
    await expect(firstTitle).toHaveValue("Owner draft");
    await expect(firstSource).toHaveValue("**Owner text awaiting save**\n");
    await expect(save).toBeEnabled();

    await save.click();
    await expect(conflict).toBeVisible();
    await conflict
      .getByRole("button", { name: "Overwrite with my version", exact: true })
      .click();
    await expect(conflict).toBeHidden();
    await expect(save).toBeHidden();
    await expect(firstSource).toHaveValue("**Owner text awaiting save**\n");
    await page
      .getByRole("button", { name: "View formatted document", exact: true })
      .click();
    await expect(firstBody.locator("strong")).toHaveText(
      "Owner text awaiting save",
    );
    await second.reload();
    await expect(
      second.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Owner draft");
    await expect(
      second.getByRole("textbox", { name: "Document content" }),
    ).toHaveText("Owner text awaiting save");

    await replaceDraft(page, "Discarded local title", "Discarded local body");
    await replaceDraft(second, "Latest shared title", "Latest shared body");
    await saveDocument(second);
    await save.click();
    await expect(conflict).toBeVisible();
    await conflict
      .getByRole("button", { name: "Reload latest", exact: true })
      .click();
    await expect(conflict).toBeHidden();
    await expect(firstTitle).toHaveValue("Latest shared title");
    await expect(firstBody).toHaveText("Latest shared body");
    await expect(save).toBeHidden();
    await firstBody.press("ControlOrMeta+z");
    await expect(firstBody).toHaveText("Latest shared body");
    await expect(save).toBeHidden();
    expect(
      await originalCanvas.evaluate((element) => element.isConnected),
    ).toBe(true);
    await originalCanvas.dispose();
  } finally {
    await secondContext.close();
  }
});

for (const loss of ["demoted", "removed"] as const) {
  test(`keeps a locked document draft when its Editor is ${loss}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const projectName = `Document access ${loss} E2E`;
    const url = await createSharedDocument(page, projectName);
    const editorContext = await browser.newContext();
    try {
      const editorPage = await editorContext.newPage();
      await login(editorPage, "editor@weaver.local");
      await editorPage.goto(url);
      await replaceDraft(
        editorPage,
        "Local title to preserve",
        "Local body to preserve",
      );
      const body = editorPage.getByRole("textbox", {
        name: "Document content",
        includeHidden: true,
      });
      const title = editorPage.getByRole("textbox", { name: "Document title" });
      const originalCanvas = await body.elementHandle();
      await editorPage
        .getByRole("button", { name: "View Markdown source", exact: true })
        .click();
      const rawBody = editorPage.getByRole("textbox", {
        name: "Document Markdown source",
        exact: true,
      });
      await rawBody.fill("**Raw body to preserve**\n");
      await expect(rawBody).toBeEditable();

      await page
        .getByRole("list", { name: `${projectName} sections` })
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      const member = page
        .getByRole("region", { name: "Project members" })
        .getByRole("row")
        .filter({ hasText: "editor@weaver.local" });
      if (loss === "demoted") {
        await member
          .getByRole("combobox", {
            name: "Project role for editor@weaver.local",
          })
          .click();
        await page.getByRole("option", { name: "Viewer", exact: true }).click();
        await expect(
          member.getByRole("combobox", {
            name: "Project role for editor@weaver.local",
          }),
        ).toHaveText("Viewer");
      } else {
        await member
          .getByRole("button", { name: "Remove editor@weaver.local" })
          .click();
        const remove = page.getByRole("dialog", { name: "Remove member" });
        await remove
          .getByRole("button", { name: "Remove", exact: true })
          .click();
        // The open modal hides background rows from role locators while removal is pending.
        await expect(remove).toBeHidden();
        await expect(member).toHaveCount(0);
      }
      await refreshMembershipOnReturn(editorPage);
      await expect(
        editorPage.getByText(
          "Editing access is no longer available. Your local changes are preserved; you can copy or discard them.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(body).toHaveAttribute("contenteditable", "false");
      await expect(title).toHaveAttribute("readonly", "");
      await expect(title).toHaveValue("Local title to preserve");
      await expect(rawBody).toHaveAttribute("readonly", "");
      await expect(rawBody).toHaveValue("**Raw body to preserve**\n");
      await expect(
        editorPage.getByRole("button", { name: "Save document", exact: true }),
      ).toBeDisabled();
      expect(
        await originalCanvas.evaluate((element) => element.isConnected),
      ).toBe(true);
      await originalCanvas.dispose();

      await editorPage
        .getByRole("button", { name: "Discard changes", exact: true })
        .click();
      const discard = editorPage.getByRole("dialog", {
        name: "Discard unsaved changes?",
      });
      await discard
        .getByRole("button", { name: "Keep editing", exact: true })
        .click();
      await expect(rawBody).toHaveValue("**Raw body to preserve**\n");
      await editorPage
        .getByRole("button", { name: "Discard changes", exact: true })
        .click();
      await discard
        .getByRole("button", { name: "Discard changes", exact: true })
        .click();
      await expect(body).toHaveCount(0);
      if (loss === "demoted") {
        await expect(editorPage.getByRole("article")).toContainText(
          "Original saved body",
        );
        await expect(
          editorPage.getByRole("heading", {
            name: "Shared document",
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await expect(
          editorPage.getByRole("heading", {
            name: "Project not found",
            exact: true,
          }),
        ).toBeVisible();
      }
    } finally {
      await editorContext.close();
    }
  });
}
