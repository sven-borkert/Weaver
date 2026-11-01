import { expect, test, type Page } from "@playwright/test";
import { login, logout, openNewProjectDialog } from "./helpers";
import { saveDocument } from "./document-helpers";

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

async function createDocument(page: Page, projectId: string, title: string) {
  await page.goto(`/projects/${projectId}/documents`);
  await page.getByRole("button", { name: "New document" }).click();
  const dialog = page.getByRole("dialog", { name: "New document" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Document content" }),
  ).toBeVisible();
  return page.url();
}

test.describe("Project activity", () => {
  test("latest content, project pins and exact overview navigation", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, "owner@weaver.local");
    const projectId = await createProject(page, "Dashboard content E2E");
    const documentUrl = await createDocument(
      page,
      projectId,
      "Dashboard runbook",
    );
    await page
      .getByRole("textbox", { name: "Document content" })
      .fill("Latest runbook update");
    await saveDocument(page);
    await page.goto(`/projects/${projectId}/tables`);
    await page.getByRole("button", { name: "New table", exact: true }).click();
    const tableDialog = page.getByRole("dialog", {
      name: "New table",
      exact: true,
    });
    await tableDialog.getByLabel("Title").fill("Dashboard budget");
    await tableDialog
      .getByRole("button", { name: "Create table", exact: true })
      .click();
    await expect(
      page.getByRole("grid", { name: "Dashboard budget table grid" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add row", exact: true }).click();
    const grid = page.getByRole("grid", {
      name: "Dashboard budget table grid",
    });
    const cell = grid.getByRole("row").nth(1).getByRole("gridcell").nth(1);
    await cell.dblclick();
    await page.keyboard.insertText("Dashboard budget line");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    await expect(grid).toContainText("Dashboard budget line");
    await page.goto(`/projects/${projectId}/activity`);
    const sections = page.getByRole("list", {
      name: "Dashboard content E2E sections",
    });
    await expect(
      sections.getByRole("link", { name: "Activity", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      sections.getByRole("link", { name: "Documents", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
    await page
      .getByRole("button", { name: "Manage pinned content", exact: true })
      .click();
    const pinsDialog = page.getByRole("dialog", {
      name: "Manage pinned content",
      exact: true,
    });
    await pinsDialog.getByRole("radio", { name: /Dashboard runbook/ }).check();
    await pinsDialog.getByLabel("Content type").selectOption("table");
    await expect(
      pinsDialog.getByRole("button", { name: "Pin", exact: true }),
    ).toBeDisabled();
    await pinsDialog.getByLabel("Content type").selectOption("document");
    await pinsDialog.getByRole("radio", { name: /Dashboard runbook/ }).check();
    await pinsDialog
      .getByLabel("Search content")
      .fill("nothing matches this title");
    await expect(
      pinsDialog.getByRole("button", { name: "Pin", exact: true }),
    ).toBeDisabled();
    await pinsDialog.getByLabel("Search content").fill("Dashboard runbook");
    await pinsDialog.getByRole("radio", { name: /Dashboard runbook/ }).check();
    await pinsDialog.getByRole("button", { name: "Pin", exact: true }).click();
    await pinsDialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Manage pinned content", exact: true }),
    ).toBeFocused();
    const pins = page.getByRole("region", {
      name: "Pinned content",
      exact: true,
    });
    await expect(
      pins.getByRole("link", { name: "Dashboard runbook", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      pins.getByRole("link", { name: "Dashboard runbook", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Manage pinned content", exact: true })
      .click();
    await pinsDialog
      .getByRole("button", { name: "Remove Dashboard runbook", exact: true })
      .click();
    await pinsDialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      pins.getByRole("link", { name: "Dashboard runbook", exact: true }),
    ).toHaveCount(0);
    await sections
      .getByRole("link", { name: "Documents", exact: true })
      .click();
    await expect(
      sections.getByRole("link", { name: "Activity", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
    await page.goto(documentUrl);
    await page
      .getByRole("textbox", { name: "Document content" })
      .fill("Unsaved dashboard navigation");
    const cancelled = page.waitForEvent("dialog");
    void sections.getByRole("link", { name: "Activity", exact: true }).click();
    await (await cancelled).dismiss();
    await expect(page).toHaveURL(documentUrl);
    await expect(
      page.getByRole("textbox", { name: "Document content" }),
    ).toHaveText("Unsaved dashboard navigation");
    const confirmed = page.waitForEvent("dialog");
    void sections.getByRole("link", { name: "Activity", exact: true }).click();
    await (await confirmed).accept();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/activity$`),
    );
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await sections.getByRole("link", { name: "Tables", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tables$`));
    await sections.getByRole("link", { name: "Activity", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/activity$`),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    const navigation = page.getByRole("dialog", {
      name: "Navigation",
      exact: true,
    });
    await navigation
      .getByRole("link", { name: "Documents", exact: true })
      .click();
    await expect(navigation).toBeHidden();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/documents$`),
    );
    await page.getByRole("button", { name: "Open navigation" }).click();
    await navigation
      .getByRole("link", { name: "Activity", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Dashboard content E2E", exact: true }),
    ).toBeVisible();
  });

  test("viewing a task result on project activity preserves its unread receipt", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, "owner@weaver.local");
    const projectId = await createProject(page, "Dashboard result E2E");
    await createDocument(page, projectId, "Digest source");
    await page.goto(`/projects/${projectId}/tasks`);
    await page.getByRole("button", { name: "New task" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Dashboard digest");
    await page.getByRole("tab", { name: "Instructions" }).click();
    await page
      .getByLabel("Instruction", { exact: true })
      .fill("Summarize what changed since the last run.");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page
      .getByRole("button", { name: "Actions for Dashboard digest" })
      .click();
    await page.getByRole("menuitem", { name: "Run now" }).click();
    await page.goto(
      `/account/background-work?audience=mine&projectId=${projectId}`,
    );
    await page
      .getByRole("combobox", { name: "View", exact: true })
      .selectOption("recent");
    const result = page
      .getByRole("row")
      .filter({ hasText: "Dashboard digest" });
    await expect(result.getByText("Succeeded", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      result.getByText("Unseen result", { exact: true }),
    ).toBeVisible();
    await page.goto(`/projects/${projectId}/activity`);
    await expect(
      page
        .getByRole("region", { name: "Latest activity", exact: true })
        .getByRole("link", { name: "Dashboard digest", exact: true }),
    ).toBeVisible();
    await page.goto(`/projects/${projectId}/activity`);
    await expect(
      page
        .getByRole("region", { name: "Latest activity", exact: true })
        .getByRole("link", { name: "Dashboard digest", exact: true }),
    ).toBeVisible();
    await page.goto(
      `/account/background-work?audience=mine&projectId=${projectId}`,
    );
    await page
      .getByRole("combobox", { name: "View", exact: true })
      .selectOption("recent");
    await expect(
      result.getByText("Unseen result", { exact: true }),
    ).toBeVisible();
    await logout(page);
    await login(page, "viewer@weaver.local");
    await page.goto(`/projects/${projectId}/activity`);
    // The viewer is not a member: the activity region may render its
    // "unavailable" state instead of disappearing, so only the link itself
    // is a reliable absence check.
    await expect(
      page.getByRole("link", { name: "Dashboard digest", exact: true }),
    ).toHaveCount(0);
  });
});

test("overview removes curator controls after a live role downgrade", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await login(page, "owner@weaver.local");
  const projectId = await createProject(page, "Dashboard roles E2E");
  await page.getByRole("button", { name: "Add member" }).click();
  const addMember = page.getByRole("dialog", { name: "Add member" });
  await addMember.getByLabel("Email").fill("viewer@weaver.local");
  await addMember.getByLabel("Role").click();
  await page.getByRole("option", { name: "Maintainer", exact: true }).click();
  await addMember.getByRole("button", { name: "Add", exact: true }).click();
  const member = page
    .getByRole("row")
    .filter({ hasText: "viewer@weaver.local" });
  await expect(member).toBeVisible();
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  try {
    await login(memberPage, "viewer@weaver.local");
    await memberPage.goto(`/projects/${projectId}/activity`);
    await expect(
      memberPage.getByRole("button", {
        name: "Manage pinned content",
        exact: true,
      }),
    ).toBeVisible();
    await memberPage
      .getByRole("button", { name: "Manage pinned content", exact: true })
      .click();
    const pinDialog = memberPage.getByRole("dialog", {
      name: "Manage pinned content",
      exact: true,
    });
    await expect(pinDialog).toBeVisible();
    await member
      .getByRole("combobox", { name: "Project role for viewer@weaver.local" })
      .click();
    await page.getByRole("option", { name: "Viewer", exact: true }).click();
    await expect(
      member.getByRole("combobox", {
        name: "Project role for viewer@weaver.local",
      }),
    ).toHaveText("Viewer");
    await expect(pinDialog).toBeHidden({ timeout: 45_000 });
    await expect(
      memberPage.getByRole("region", { name: "Project activity", exact: true }),
    ).toBeFocused();
    await expect(
      memberPage.getByRole("heading", {
        name: "Dashboard roles E2E",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole("button", {
        name: "Manage pinned content",
        exact: true,
      }),
    ).toHaveCount(0);
    await member
      .getByRole("combobox", { name: "Project role for viewer@weaver.local" })
      .click();
    await page.getByRole("option", { name: "Maintainer", exact: true }).click();
    await expect(
      memberPage.getByRole("button", {
        name: "Manage pinned content",
        exact: true,
      }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(pinDialog).toBeHidden();
    await member
      .getByRole("combobox", { name: "Project role for viewer@weaver.local" })
      .click();
    await page.getByRole("option", { name: "Viewer", exact: true }).click();
    await expect(
      memberPage.getByRole("button", {
        name: "Manage pinned content",
        exact: true,
      }),
    ).toHaveCount(0, { timeout: 45_000 });
    await memberPage
      .getByRole("region", { name: "Active work", exact: true })
      .getByRole("link", { name: "View all", exact: true })
      .click();
    await expect(
      memberPage.getByRole("combobox", { name: "Audience", exact: true }),
    ).toHaveValue("mine");
    await expect(
      memberPage.getByRole("combobox", { name: "Project", exact: true }),
    ).toHaveValue(projectId);
  } finally {
    await memberContext.close();
  }
});

test("activity retains stale content on a failed refresh and Retry recovers", async ({
  page,
}) => {
  await login(page, "owner@weaver.local");
  const projectId = await createProject(page, "Dashboard retry E2E");
  await createDocument(page, projectId, "Dashboard retry runbook");
  await page.goto(`/projects/${projectId}/activity`);
  const activity = page.getByRole("region", {
    name: "Latest activity",
    exact: true,
  });
  const document = activity.getByRole("link", {
    name: "Dashboard retry runbook",
    exact: true,
  });
  await expect(document).toBeVisible();
  let unavailable = true;
  await page.route("**/api/trpc/*dashboard.activity*", async (route) => {
    if (unavailable) await route.abort("failed");
    else await route.continue();
  });
  await activity.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(activity.getByRole("alert")).toContainText(
    /out of date|earlier|stale/i,
  );
  await expect(document).toBeVisible();
  unavailable = false;
  await activity.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(activity.getByRole("alert")).toHaveCount(0);
  await expect(document).toBeVisible();
});

test("a shared project never exposes another member's assistant result", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, "owner@weaver.local");
  const projectId = await createProject(
    page,
    "Dashboard private assistant E2E",
  );
  await page.getByRole("button", { name: "Add member" }).click();
  const member = page.getByRole("dialog", { name: "Add member" });
  await member.getByLabel("Email").fill("viewer@weaver.local");
  await member.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "viewer@weaver.local" }),
  ).toBeVisible();
  await createDocument(page, projectId, "Shared dashboard source");
  await page.goto(`/projects/${projectId}/activity`);
  await page.getByRole("button", { name: "Assistant" }).click();
  const assistantPanel = page.getByRole("dialog", { name: "Assistant" });
  await assistantPanel
    .getByRole("button", { name: "New", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message the assistant" });
  await composer.fill("say something plain");
  await composer.press("Enter");
  await expect(
    page
      .getByRole("paragraph")
      .filter({ hasText: "Here is a plain answer with no sources." }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(composer).toBeEnabled();
  // The panel doesn't navigate to a full-page /assistant/<id> route, so pull
  // the conversation id from its "Open full page" link instead.
  await assistantPanel
    .getByRole("button", { name: "Conversation menu" })
    .click();
  const conversationPath = await page
    .getByRole("menuitem", { name: "Open full page" })
    .getAttribute("href");
  await page.keyboard.press("Escape");
  await assistantPanel.getByRole("button", { name: "Close assistant" }).click();
  await page.goto(`/projects/${projectId}/activity`);
  const activity = page.getByRole("region", {
    name: "Latest activity",
    exact: true,
  });
  await expect(activity.locator(`a[href="${conversationPath}"]`)).toBeVisible();
  await logout(page);
  await login(page, "viewer@weaver.local");
  await page.goto(`/projects/${projectId}/activity`);
  await expect(
    page.getByRole("heading", {
      name: "Dashboard private assistant E2E",
      exact: true,
    }),
  ).toBeVisible();
  await expect(activity.locator(`a[href="${conversationPath}"]`)).toHaveCount(
    0,
  );
  await activity
    .getByRole("button", { name: "Changes by others", exact: true })
    .click();
  await expect(
    activity.getByRole("link", {
      name: "Shared dashboard source",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage pinned content", exact: true }),
  ).toHaveCount(0);
});
