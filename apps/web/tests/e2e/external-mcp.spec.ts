import { expect, test, type Page } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";

const NAME = "Synthetic counter MCP";
const PROJECT = "External MCP E2E";
const fixtureBase = process.env.WEAVER_E2E_EXTERNAL_MCP_BASE_URL!;
const shortcut = process.platform === "darwin" ? "Meta+j" : "Control+j";
let projectId = "";
let connectionUrl = "";
const panel = (page: Page) =>
  page.getByRole("dialog", { name: "Assistant", exact: true });
const composer = (page: Page) =>
  panel(page).getByRole("textbox", { name: "Message the assistant" });
const approval = (page: Page) =>
  panel(page).getByRole("region", { name: "External tool approval" });

async function navigate(page: Page, url: string) {
  if (await panel(page).isVisible()) {
    await panel(page).getByRole("button", { name: "Close assistant" }).click();
  }
  await page.goto(url);
}

async function fixtureState(): Promise<{
  counter: number;
  reads: number;
  writes: number;
}> {
  const response = await fetch(`${fixtureBase}/__fixture/state`);
  expect(response.ok).toBe(true);
  return (await response.json()) as {
    counter: number;
    reads: number;
    writes: number;
  };
}
async function fixtureControl(action: "reset" | "disconnect_next_write") {
  const response = await fetch(`${fixtureBase}/__fixture/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  expect(response.ok).toBe(true);
}
// Saving a connection bumps its revision, which invalidates pending approvals.
async function saveConnection(page: Page) {
  await navigate(page, connectionUrl);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit connection" });
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(dialog).toBeHidden();
}
async function startConversation(page: Page) {
  await page.setViewportSize({ width: 1700, height: 1000 });
  await navigate(page, `/projects/${projectId}`);
  if (!(await panel(page).isVisible())) await page.keyboard.press(shortcut);
  await panel(page).getByRole("button", { name: "New", exact: true }).click();
}
async function send(page: Page, prompt: string) {
  await expect(composer(page)).toBeEnabled();
  await composer(page).fill(prompt);
  await composer(page).press("Enter");
}
async function finished(page: Page, status = "completed") {
  await expect(
    panel(page)
      .getByRole("paragraph")
      .filter({ hasText: new RegExp(`^External tool ${status}\\.\\s*$`) }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(composer(page)).toBeEnabled();
}
async function pendingWrite(page: Page, value: number) {
  await startConversation(page);
  const before = await fixtureState();
  await send(page, `e2e external set ${value}`);
  await expect(
    approval(page).getByRole("button", { name: "Approve", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  expect(await fixtureState()).toEqual(before);
  return before;
}

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "admin@weaver.local");
});

test("user adds, discovers and enables a connection from Account", async ({
  page,
}) => {
  await fixtureControl("reset");
  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill(PROJECT);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: PROJECT })).toBeVisible();
  projectId = new URL(page.url()).pathname.split("/")[2]!;
  await navigate(page, "/admin/connections");
  await expect(page).toHaveURL(/\/account\/connections$/);
  await page.getByRole("button", { name: "Add connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Add connection" });
  await dialog.getByLabel("Name", { exact: true }).fill(NAME);
  await dialog.getByLabel("Endpoint").fill(`${fixtureBase}/mcp`);
  await dialog.getByLabel("Authentication").selectOption("none");
  await expect(dialog.getByLabel("Ask before")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(page).toHaveURL(/\/account\/connections\/[0-9a-f-]+/);
  connectionUrl = page.url().split("?")[0]!;
  await expect(page.getByRole("heading", { name: "Tools" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Enable read_counter")).not.toBeChecked();
  await expect(page.getByLabel("Effect of read_counter")).toHaveValue("read");
  await expect(page.getByLabel("Effect of set_counter")).toHaveValue("write");
  await page.getByRole("button", { name: "Enable all read tools" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enable all", exact: true })
    .click();
  await expect(page.getByLabel("Enable read_counter")).toBeChecked();
  await page.getByLabel("Enable set_counter").check();
  await expect(page.getByLabel("Enable set_counter")).toBeChecked();
  expect(await fixtureState()).toEqual({
    counter: 0,
    reads: 0,
    writes: 0,
    disconnectNextWrite: false,
  });
});

test("read runs without approval and write asks", async ({ page }) => {
  await startConversation(page);
  await send(page, "e2e external read");
  await finished(page);
  await expect(approval(page)).toHaveCount(0);
  expect((await fixtureState()).reads).toBe(1);
  await expect(
    panel(page).getByRole("region", { name: "External sources" }),
  ).toContainText(NAME);
  await expect(
    panel(page).getByRole("region", { name: "External sources" }),
  ).toContainText("read_counter");
  const before = await fixtureState();
  await send(page, "e2e external set 1");
  await expect(
    approval(page).getByRole("button", { name: "Approve", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  expect(await fixtureState()).toEqual(before);
  await approval(page)
    .getByRole("button", { name: "Deny", exact: true })
    .click();
  await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
  expect(await fixtureState()).toEqual(before);
});

test("ask write survives reload without dispatch and executes once after approval", async ({
  page,
}) => {
  await pendingWrite(page, 1);
  await approval(page).getByText("Complete arguments", { exact: true }).click();
  await expect(approval(page).locator("pre")).toContainText('"value": 1');
  await page.reload();
  await expect(
    approval(page).getByRole("button", { name: "Approve", exact: true }),
  ).toBeVisible();
  expect((await fixtureState()).counter).toBe(0);
  await approval(page)
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await finished(page);
  expect((await fixtureState()).counter).toBe(1);
  expect((await fixtureState()).writes).toBe(1);
});

test("denial does not dispatch the write", async ({ page }) => {
  const before = await pendingWrite(page, 2);
  await approval(page)
    .getByRole("button", { name: "Deny", exact: true })
    .click();
  await finished(page, "denied");
  expect(await fixtureState()).toEqual(before);
});

test("connection changes invalidate a pending approval without dispatch", async ({
  page,
}) => {
  const before = await pendingWrite(page, 3);
  const other = await page.context().newPage();
  try {
    await saveConnection(other);
    await expect(approval(page).getByText(/· invalidated/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      approval(page).getByRole("button", { name: "Approve", exact: true }),
    ).toHaveCount(0);
    await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
    await page.reload();
    await expect(approval(page).getByText(/· invalidated/)).toBeVisible();
    expect(await fixtureState()).toEqual(before);
  } finally {
    await other.close();
  }
});

// The assistant's activity for the lost write, keyed on its own status line.
function unknownMessage(page: Page) {
  return panel(page)
    .getByRole("listitem")
    .filter({ hasText: "External tool unknown." });
}

test("Auto-approve write has no approval prompt; a lost response is unknown and never replayed", async ({
  page,
}) => {
  await startConversation(page);
  // The box is server-controlled, so it only shows checked once the save returns.
  await panel(page).getByLabel("Auto-approve").click();
  await expect(panel(page).getByLabel("Auto-approve")).toBeChecked();
  await send(page, "e2e external set 4");
  await finished(page);
  await expect(approval(page)).toHaveCount(0);
  expect((await fixtureState()).counter).toBe(4);
  expect((await fixtureState()).writes).toBe(2);
  await fixtureControl("disconnect_next_write");
  await send(page, "e2e external set 5");
  await finished(page, "unknown");
  await unknownMessage(page)
    .getByRole("button", { name: "Used 1 tool", exact: true })
    .click();
  await expect(
    unknownMessage(page).getByText(
      /outcome unknown — check the external service before trying again/,
    ),
  ).toBeVisible();
  expect((await fixtureState()).counter).toBe(5);
  expect((await fixtureState()).writes).toBe(3);
  await page.reload();
  await expect(composer(page)).toBeEnabled();
  await unknownMessage(page)
    .getByRole("button", { name: "Used 1 tool", exact: true })
    .click();
  await expect(
    unknownMessage(page).getByText(
      /outcome unknown — check the external service before trying again/,
    ),
  ).toBeVisible();
  expect((await fixtureState()).writes).toBe(3);
});

test("task input publishes provenance", async ({ page }) => {
  await navigate(page, `/projects/${projectId}/tasks`);
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("External counter report");
  await dialog.getByRole("tab", { name: "Instructions" }).click();
  await dialog
    .getByLabel("Instruction", { exact: true })
    .fill("Report the synthetic external counter.");
  await dialog.getByRole("tab", { name: "Tools" }).click();
  await dialog.getByRole("button", { name: "Add external input" }).click();
  await dialog
    .getByLabel("Input 1 name", { exact: true })
    .fill("Counter reading");
  await dialog.getByLabel("Input 1 JSON arguments", { exact: true }).fill("{}");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("link", { name: "External counter report", exact: true })
    .click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  const success = page.getByRole("row").filter({ hasText: "Succeeded" });
  await expect(success).toBeVisible({ timeout: 60_000 });
  await expect(success).toContainText("Counter reading · Completed");
  await expect(success).toContainText("Truncated: No");
  const revision = await success.getByRole("link").innerText();
  expect(revision).toMatch(/^[0-9a-f]{7}$/);
  await page.getByRole("link", { name: "Open the report document" }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]+$/);
  const article = page.getByRole("main").getByRole("article");
  await expect(article).toContainText("Synthetic external counter: 5");
  await expect(article).toContainText(`${NAME} / read_counter`);
  await expect(article).toContainText(/retrieved .*; call [0-9a-f-]{36}/);
});
