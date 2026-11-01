import { expect, test, type Locator, type Page } from "@playwright/test";

import { login, openNewProjectDialog } from "./helpers";
import {
  expectDocumentToolbar,
  runToolbarCommand,
  saveDocument,
} from "./document-helpers";

const PROJECT_NAME = "Tables E2E";
const TABLE_TITLE = "Budget";
const SUPPORT_DOCUMENT_TITLE = "Reference Target";
const BACKLINK_DOCUMENT_TITLE = "Table Notes";

function tableGrid(page: Page): Locator {
  return page.getByRole("grid", { name: `${TABLE_TITLE} table grid` });
}

function gridRow(grid: Locator, rowIndex: number): Locator {
  return grid.getByRole("row").nth(rowIndex + 1);
}

function gridCell(
  grid: Locator,
  rowIndex: number,
  columnIndex: number,
): Locator {
  // AG Grid's leading selection cell precedes the canonical table columns.
  return gridRow(grid, rowIndex)
    .getByRole("gridcell")
    .nth(columnIndex + 1);
}

async function revealLastGridColumn(
  page: Page,
  grid: Locator,
  rowIndex: number,
): Promise<void> {
  await gridRow(grid, rowIndex).getByRole("gridcell").first().click();
  await page.keyboard.press("ControlOrMeta+ArrowRight");
}

async function enterGridValue(
  page: Page,
  cell: Locator,
  value: string,
): Promise<void> {
  await cell.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(value);
  await page.keyboard.press("Enter");
}

async function typeGridValueWithoutCommit(
  page: Page,
  cell: Locator,
  value: string,
): Promise<void> {
  await cell.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(value);
}

async function selectGridOption(
  page: Page,
  cell: Locator,
  label: string,
): Promise<void> {
  await cell.dblclick();
  const picker = cell.getByRole("combobox");
  await expect(picker).toBeVisible();
  if ((await picker.getAttribute("aria-expanded")) !== "true") {
    await picker.click();
  }
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("option", { name: label, exact: true })
    .click({ timeout: 5_000 });
  await expect(cell).toHaveText(label);
}

async function openAddColumnDialog(page: Page): Promise<void> {
  // Scoped to the workspace region: the dialog this opens is portaled
  // outside it and has its own submit button with the same accessible
  // name ("Add column"), which an unscoped query would also match.
  const workspace = page.getByRole("region", { name: "Table workspace" });
  // The desktop "Add column" button is `md:hidden`'s inverse (hidden below
  // md); the narrow-viewport layout collapses it into the "Table editing
  // actions" menu instead.
  const desktopTrigger = workspace.getByRole("button", { name: "Add column" });
  if (await desktopTrigger.isVisible()) {
    await desktopTrigger.click();
    return;
  }
  await workspace
    .getByRole("button", { name: "Table editing actions" })
    .click();
  await page.getByRole("menuitem", { name: "Add column" }).click();
}

async function addColumn(
  page: Page,
  name: string,
  type:
    | "Number"
    | "Date"
    | "Date & time"
    | "Select"
    | "Multi-select"
    | "Boolean"
    | "Document",
  option?: string,
): Promise<void> {
  await openAddColumnDialog(page);
  const dialog = page.getByRole("dialog", { name: "Add column" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Type").click();
  await page.getByRole("option", { name: type, exact: true }).click();
  if (option) {
    await dialog.getByLabel("Option 1 label").fill(option);
  }
  await dialog.getByRole("button", { name: "Add column" }).click();
  await expect(dialog).toBeHidden();
}

async function addMember(
  page: Page,
  email: string,
  role: "Editor" | "Viewer",
): Promise<void> {
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog", { name: "Add member" });
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Role").click();
  await page.getByRole("option", { name: role, exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: email })).toBeVisible();
}

async function createDocument(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New document" }).click();
  const dialog = page.getByRole("dialog", { name: "New document" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Document content" }),
  ).toBeVisible();
}

test.describe.serial("tables", () => {
  test("completes the Phase 2 table workflow", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await login(page, "owner@weaver.local");

    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill(PROJECT_NAME);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: PROJECT_NAME }),
    ).toBeVisible();

    await addMember(page, "editor@weaver.local", "Editor");
    await addMember(page, "viewer@weaver.local", "Viewer");

    await page
      .getByRole("list", { name: `${PROJECT_NAME} sections` })
      .getByRole("link", { name: "Documents", exact: true })
      .click();
    await createDocument(page, SUPPORT_DOCUMENT_TITLE);
    await page
      .getByRole("navigation", { name: "breadcrumb" })
      .getByRole("link", { name: "Documents", exact: true })
      .click();
    await page
      .getByRole("list", { name: `${PROJECT_NAME} sections` })
      .getByRole("link", { name: "Tables", exact: true })
      .click();

    await page.getByRole("button", { name: "New folder" }).click();
    const folderDialog = page.getByRole("dialog", {
      name: "New table folder",
    });
    await folderDialog.getByLabel("Name").fill("Planning");
    await folderDialog.getByRole("button", { name: "Create folder" }).click();
    // Creating a folder stays on the current level; open it explicitly.
    await page.getByRole("link", { name: "Planning", exact: true }).click();
    await expect(page).toHaveURL(/\/tables\?folder=planning$/);

    await page.getByRole("button", { name: "New table" }).click();
    const tableDialog = page.getByRole("dialog", { name: "New table" });
    await tableDialog.getByLabel("Title").fill(TABLE_TITLE);
    await expect(tableDialog.getByLabel("Table folder")).toHaveText("Planning");
    await tableDialog.getByRole("button", { name: "Create table" }).click();

    let grid = tableGrid(page);
    await expect(grid).toBeVisible();
    await expect(
      grid.getByRole("columnheader", { name: /Name/ }),
    ).toBeVisible();
    await expect(page.getByText("0 rows · 1 column")).toBeVisible();

    await addColumn(page, "Amount", "Number");
    await addColumn(page, "Due", "Date");
    await addColumn(page, "Status", "Select", "Planned");
    await addColumn(page, "Approved", "Boolean");
    await addColumn(page, "Source", "Document");
    await page.getByRole("button", { name: "Add row" }).click();
    await page.getByRole("button", { name: "Add row" }).click();

    await typeGridValueWithoutCommit(page, gridCell(grid, 0, 0), "Alpha");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    grid = tableGrid(page);
    await expect(gridRow(grid, 0)).toContainText("Alpha");

    await typeGridValueWithoutCommit(page, gridCell(grid, 0, 1), "42.5");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    grid = tableGrid(page);
    await expect(gridRow(grid, 0)).toContainText("42.5");

    await typeGridValueWithoutCommit(page, gridCell(grid, 1, 0), "Beta");
    await typeGridValueWithoutCommit(page, gridCell(grid, 1, 1), "7");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    grid = tableGrid(page);
    await expect(gridRow(grid, 1)).toContainText("Beta");
    await expect(gridRow(grid, 1)).toContainText("7");

    const dueDateCell = gridCell(grid, 0, 2);
    await dueDateCell.dblclick();
    const dueDateEditor = dueDateCell.getByLabel("Input Editor", {
      exact: true,
    });
    await dueDateEditor.fill("2026-08-29");
    await dueDateEditor.press("Enter");
    const statusCell = gridCell(grid, 0, 3);
    await statusCell.dblclick();
    await gridCell(grid, 0, 2).click();
    await expect(statusCell.getByRole("combobox")).toHaveCount(0);
    await expect(statusCell).toHaveText("—");
    await selectGridOption(page, statusCell, "Planned");
    await gridCell(grid, 0, 4).dblclick();
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await gridRow(grid, 0)
      .getByRole("button", { name: /Choose document/ })
      .click();
    await page
      .getByRole("combobox", { name: "Choose a document" })
      .fill(SUPPORT_DOCUMENT_TITLE);
    await page
      .getByRole("option", { name: new RegExp(`^${SUPPORT_DOCUMENT_TITLE}`) })
      .click();

    await gridRow(grid, 1).getByRole("gridcell").nth(1).click();
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    const clearedStatusCell = gridCell(grid, 1, 3);
    await selectGridOption(page, clearedStatusCell, "Planned");
    await clearedStatusCell.click();
    await page.keyboard.press("Delete");
    await expect(clearedStatusCell).toHaveText("—");
    const clearedBooleanCell = gridCell(grid, 1, 4);
    await clearedBooleanCell.dblclick();
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await expect(
      gridRow(grid, 1).getByRole("checkbox", { name: "Approved: true" }),
    ).toBeChecked();
    await gridRow(grid, 1)
      .getByRole("gridcell", { name: "Approved: true", exact: true })
      .click();
    await page.keyboard.press("Delete");
    await expect(gridRow(grid, 1)).toContainText("Approved: empty");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    grid = tableGrid(page);
    await expect(grid).toBeVisible();
    await expect(gridRow(grid, 0)).toContainText("Alpha");
    await expect(gridRow(grid, 0)).toContainText("42.5");
    await expect(gridRow(grid, 0)).toContainText("2026-08-29");
    await revealLastGridColumn(page, grid, 0);
    await expect(gridRow(grid, 0)).toContainText("Planned");
    await expect(
      gridRow(grid, 0).getByRole("checkbox", { name: "Approved: true" }),
    ).toBeChecked();
    await expect(
      gridRow(grid, 0).getByRole("button", {
        name: `Choose document. Current value: ${SUPPORT_DOCUMENT_TITLE}`,
      }),
    ).toBeVisible();
    await page.keyboard.press("ControlOrMeta+ArrowLeft");
    await expect(gridRow(grid, 1)).toContainText("Beta");
    await expect(gridCell(grid, 1, 3)).toHaveText("—");
    await expect(gridRow(grid, 1)).toContainText("Approved: empty");

    const nameHeader = grid.getByRole("columnheader", { name: /Name/ });
    await nameHeader.click();
    await nameHeader.click();
    await expect(gridRow(grid, 0)).toContainText("Beta");
    await expect(gridRow(grid, 1)).toContainText("Alpha");
    await nameHeader.press("ControlOrMeta+Enter");
    const filterValue = page.getByRole("textbox", { name: "Filter Value" });
    await expect(filterValue).toBeFocused();
    await filterValue.fill("Alpha");
    await expect(grid.getByRole("row")).toHaveCount(2);
    await expect(gridRow(grid, 0)).toContainText("Alpha");

    await page.reload();
    grid = tableGrid(page);
    await expect(gridRow(grid, 0)).toContainText("Alpha");
    await expect(gridRow(grid, 1)).toContainText("Beta");

    await typeGridValueWithoutCommit(
      page,
      gridCell(grid, 0, 0),
      "Navigation draft",
    );
    let promptPromise = page.waitForEvent("dialog");
    // The explorer is folder-scoped: leave through the folder crumb so the
    // table's row is on the page we land on.
    const tablesCrumb = page
      .getByRole("navigation", { name: "breadcrumb" })
      .getByRole("link", { name: "Planning", exact: true });
    let navigation = tablesCrumb.click();
    let prompt = await promptPromise;
    expect(prompt.message()).toBe("Discard unsaved changes?");
    await prompt.dismiss();
    await navigation;
    await expect(gridRow(grid, 0)).toContainText("Navigation draft");

    promptPromise = page.waitForEvent("dialog");
    navigation = tablesCrumb.click();
    prompt = await promptPromise;
    await prompt.accept();
    await navigation;
    await expect(
      page.getByRole("table", { name: "Tables and folders" }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: TABLE_TITLE, exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/tables\/[^/?#]+$/);
    await expect(tableGrid(page)).toBeVisible();

    const tableUrl = page.url();
    const editorContext = await browser.newContext();
    const editorPage = await editorContext.newPage();
    await login(editorPage, "editor@weaver.local");
    await editorPage.goto(tableUrl);
    const editorGrid = tableGrid(editorPage);
    await expect(editorGrid).toBeVisible();

    grid = tableGrid(page);
    await enterGridValue(page, gridCell(grid, 0, 0), "Owner draft");
    await enterGridValue(
      editorPage,
      gridCell(editorGrid, 0, 0),
      "Committed elsewhere",
    );
    await editorPage.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editorPage.getByText("All changes saved")).toBeVisible();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    let conflictDialog = page.getByRole("dialog", {
      name: "This table changed elsewhere",
    });
    await expect(conflictDialog).toBeVisible();
    await expect(
      conflictDialog.getByRole("heading", { name: "Cells" }),
    ).toBeVisible();
    await expect(conflictDialog).toContainText("Row 1 · Name");
    await conflictDialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(gridRow(grid, 0)).toContainText("Owner draft");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    conflictDialog = page.getByRole("dialog", {
      name: "This table changed elsewhere",
    });
    await expect(conflictDialog).toBeVisible();
    promptPromise = page.waitForEvent("dialog");
    const reloadCommitted = conflictDialog
      .getByRole("button", { name: "Reload committed version" })
      .click();
    prompt = await promptPromise;
    expect(prompt.message()).toBe("Discard unsaved changes?");
    await prompt.accept();
    await reloadCommitted;
    await expect(conflictDialog).toBeHidden();
    grid = tableGrid(page);
    await expect(gridRow(grid, 0)).toContainText("Committed elsewhere");

    const expandContext = page.getByRole("button", {
      name: "Expand table context",
    });
    if (await expandContext.isVisible()) await expandContext.click();
    const tableContext = page.getByRole("complementary", {
      name: "Table context",
    });
    await tableContext.getByRole("tab", { name: "History" }).click();
    const historyUpdates = tableContext.getByRole("button", {
      name: /update: tables\/planning\/budget\.table/,
    });
    await expect(historyUpdates).toHaveCount(5);
    await historyUpdates.nth(1).click();
    await expect(
      page.getByRole("heading", { name: "Version comparison" }),
    ).toBeVisible();
    const cellsDiff = page.getByRole("region", { name: "Cells" });
    await expect(cellsDiff).toContainText("Name: Alpha → Committed elsewhere");
    await page.getByRole("button", { name: "Restore this version" }).click();
    const restoreDialog = page.getByRole("dialog", {
      name: "Restore this table version?",
    });
    await expect(restoreDialog).toContainText("creates a new version");
    await restoreDialog
      .getByRole("button", { name: "Restore version" })
      .click();
    await expect(page.getByText("Table version restored")).toBeVisible();
    grid = tableGrid(page);
    await expect(gridRow(grid, 0)).toContainText("Alpha");
    await expect(
      tableContext.getByRole("button", {
        name: /restore: tables\/planning\/budget\.table \(from [0-9a-f]{7}\)/,
      }),
    ).toBeDisabled();
    await expect(
      tableContext.getByRole("button", {
        name: /update: tables\/planning\/budget\.table/,
      }),
    ).toHaveCount(5);

    await page
      .getByRole("list", { name: `${PROJECT_NAME} sections` })
      .getByRole("link", { name: "Documents", exact: true })
      .click();
    await createDocument(page, BACKLINK_DOCUMENT_TITLE);
    await expectDocumentToolbar(page);
    await runToolbarCommand(page, "Reference", "Insert");
    await page.getByRole("tab", { name: "Tables" }).click();
    await page
      .getByRole("combobox", { name: "Search tables" })
      .fill(TABLE_TITLE);
    await page
      .getByRole("option", { name: new RegExp(`^${TABLE_TITLE}`) })
      .click();
    await saveDocument(page);
    const tableChip = page
      .getByRole("article")
      .getByRole("link", { name: TABLE_TITLE, exact: true });
    await expect(tableChip).toBeVisible();
    await tableChip.click();
    grid = tableGrid(page);
    await expect(grid).toBeVisible();

    const expandBacklinks = page.getByRole("button", {
      name: "Expand table context",
    });
    if (await expandBacklinks.isVisible()) await expandBacklinks.click();
    const backlinksContext = page.getByRole("complementary", {
      name: "Table context",
    });
    await backlinksContext.getByRole("tab", { name: "Backlinks" }).click();
    await expect(
      backlinksContext.getByRole("link", {
        name: new RegExp(BACKLINK_DOCUMENT_TITLE),
      }),
    ).toBeVisible();

    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await login(viewerPage, "viewer@weaver.local");
    await viewerPage.goto(tableUrl);
    const viewerWorkspace = viewerPage.getByRole("region", {
      name: "Table workspace",
    });
    const viewerGrid = tableGrid(viewerPage);
    await expect(viewerGrid).toBeVisible();
    await revealLastGridColumn(viewerPage, viewerGrid, 0);
    await expect(
      viewerGrid.getByRole("link", { name: SUPPORT_DOCUMENT_TITLE }),
    ).toBeVisible();
    await expect(viewerWorkspace.getByLabel("Table title")).toHaveCount(0);
    await expect(
      viewerWorkspace.getByRole("button", { name: "Save", exact: true }),
    ).toHaveCount(0);
    await expect(
      viewerWorkspace.getByRole("button", { name: "Add column" }),
    ).toHaveCount(0);
    await expect(
      viewerWorkspace.getByRole("button", { name: "Table editing actions" }),
    ).toHaveCount(0);
    await viewerContext.close();
    await editorContext.close();

    await page.setViewportSize({ width: 700, height: 900 });
    const contextDrawerTrigger = page.getByRole("button", { name: "Context" });
    await page.getByRole("button", { name: "Table editing actions" }).click();
    const compactMenu = page.getByRole("menu");
    await expect(
      compactMenu.getByRole("menuitem", { name: "Add row" }),
    ).toBeVisible();
    await expect(
      compactMenu.getByRole("menuitem", { name: "Delete selected rows" }),
    ).toBeVisible();
    await expect(
      compactMenu.getByRole("menuitem", { name: "Add column" }),
    ).toBeVisible();
    await expect(
      compactMenu.getByRole("menuitem", { name: "Save" }),
    ).toBeVisible();
    await compactMenu.getByRole("menuitem", { name: "Name" }).hover();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Change type" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Delete column" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await contextDrawerTrigger.click();
    const contextDrawer = page.getByRole("dialog", { name: "Table context" });
    await expect(
      contextDrawer.getByRole("tab", { name: "History" }),
    ).toBeVisible();
    await contextDrawer.getByRole("button", { name: "Close" }).click();
    await expect(contextDrawerTrigger).toBeFocused();
    await page
      .getByRole("navigation", { name: "breadcrumb" })
      .getByRole("link", { name: "Tables", exact: true })
      .click();
    await expect(
      page.getByRole("table", { name: "Tables and folders" }),
    ).toBeVisible();
    await page
      .getByRole("row")
      .filter({ hasText: "Planning" })
      .getByRole("link", { name: "Planning" })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: TABLE_TITLE }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Icons view" }).click();
    await expect(
      page.getByRole("list", { name: "Tables and folders" }),
    ).toBeVisible();
    await page.getByRole("link", { name: TABLE_TITLE }).click();
    await expect(tableGrid(page)).toBeVisible();

    await page.getByRole("button", { name: "Table editing actions" }).click();
    await page.getByRole("menuitem", { name: "Add row" }).click();
    grid = tableGrid(page);
    await enterGridValue(page, gridCell(grid, 2, 0), "Narrow edit");
    await page.getByRole("button", { name: "Table editing actions" }).click();
    await page.getByRole("menuitem", { name: "Save", exact: true }).click();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    grid = tableGrid(page);
    await expect(gridRow(grid, 2)).toContainText("Narrow edit");
    await expect(grid).toBeVisible();

    // Still at the narrow 700x900 viewport: exercise the new column types
    // through the same "Table editing actions" menu used above. AG Grid
    // virtualizes columns at this viewport width, so gridCell's rendered
    // ".nth()" indexing can't reach these — index by the grid's own
    // aria-colindex instead (1 selection column + 8 data columns so far:
    // Name, Amount, Due, Status, Approved, Source, then these two).
    await addColumn(page, "Scheduled", "Date & time");
    grid = tableGrid(page);
    await revealLastGridColumn(page, grid, 0);
    const scheduledCell = gridRow(grid, 0).locator('[aria-colindex="8"]');
    await scheduledCell.dblclick();
    const scheduledInput = scheduledCell.locator(
      'input[type="datetime-local"]',
    );
    await scheduledInput.fill("2026-09-18T14:30");
    await scheduledInput.press("Enter");
    await expect(scheduledCell).toHaveText(/2026/);
    await expect(scheduledCell.locator("span[title]")).toHaveAttribute(
      "title",
      /^2026-09-18T14:30:00/,
    );

    await addColumn(page, "Tags", "Multi-select", "Alpha");
    grid = tableGrid(page);
    await revealLastGridColumn(page, grid, 0);
    const tagsCell = gridRow(grid, 0).locator('[aria-colindex="9"]');
    await tagsCell.dblclick();
    const tagsOptions = page.getByRole("listbox", { name: "Tags options" });
    await tagsOptions.getByRole("checkbox", { name: "Alpha" }).click();
    await tagsOptions.press("Enter");
    await expect(tagsCell).toContainText("Alpha");

    await page.getByRole("button", { name: "Table editing actions" }).click();
    await page.getByRole("menuitem", { name: "Save", exact: true }).click();
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.reload();
    grid = tableGrid(page);
    await revealLastGridColumn(page, grid, 0);
    const scheduledCellAfterReload = gridRow(grid, 0).locator(
      '[aria-colindex="8"]',
    );
    await expect(scheduledCellAfterReload).toHaveText(/2026/);
    await expect(
      scheduledCellAfterReload.locator("span[title]"),
    ).toHaveAttribute("title", /^2026-09-18T14:30:00/);
    await expect(gridRow(grid, 0).locator('[aria-colindex="9"]')).toContainText(
      "Alpha",
    );
  });

  test("imports a dropped CSV file as a table", async ({ page }) => {
    await login(page, "editor@weaver.local");
    await page.getByRole("button", { name: "Switch project" }).click();
    await page.getByRole("menuitem", { name: PROJECT_NAME }).click();
    await page
      .getByRole("list", { name: `${PROJECT_NAME} sections` })
      .getByRole("link", { name: "Tables", exact: true })
      .click();
    const dropZone = page.getByTestId("tables-drop-zone");
    const transfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File(["Item,Amount,Paid\nRent,1200,yes\n"], "dropped_budget.csv", {
          type: "text/csv",
        }),
      );
      dt.items.add(new File(["plain"], "ignored.txt", { type: "text/plain" }));
      return dt;
    });
    await dropZone.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(page.getByText("Imported 1 table")).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "Dropped budget" });
    await expect(row).toBeVisible();
    // Column order: Name, Rows (adapter column; no Folder column while not
    // searching), Last edited, By, actions.
    await expect(row.getByRole("cell").nth(1)).toHaveText("1");
    await row.getByRole("link", { name: "Dropped budget" }).click();
    const grid = page.getByRole("grid", { name: "Dropped budget table grid" });
    await expect(
      grid.getByRole("columnheader", { name: /Amount/ }),
    ).toBeVisible();
    await expect(gridRow(grid, 0)).toContainText("1200");
  });
});
