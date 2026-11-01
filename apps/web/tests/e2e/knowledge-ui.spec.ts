import { expect, test, type Locator, type Page } from "@playwright/test";

import { login, openNewProjectDialog } from "./helpers";
import {
  expectDocumentToolbar,
  runToolbarCommand,
  saveDocument,
} from "./document-helpers";

const PRIMARY_PROJECT = "Knowledge UI Primary";
const SECONDARY_PROJECT = "Knowledge UI Secondary";
const DEPLOYMENT_GUIDE = "Deployment Guide";
const DEPLOYMENT_TABLE = "Deployment Inventory";
const KEYWORD_RUNBOOK = "Keyword Runbook";
const SECOND_DEPLOYMENT = "Second Deployment";
const RETRY_DOCUMENT = "Deployment Retry";
const CAPACITY_DOCUMENTS = [
  ["Graph Capacity Focus A", "weaver-capacity:focus-primary"],
  ["Graph Capacity Focus B", "weaver-capacity:focus-secondary"],
  ["Graph Capacity Expand A", "weaver-capacity:expand-primary"],
  ["Graph Capacity Expand B", "weaver-capacity:expand-secondary"],
] as const;
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

type CreatedProject = { id: string; settingsUrl: string };
type CreatedDocument = { id: string; url: string };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function idAfter(segment: string, url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const index = parts.indexOf(segment);
  const id = index >= 0 ? parts[index + 1] : undefined;
  expect(id).toMatch(UUID_PATTERN);
  return id!;
}

function capacitySource(marker: string): string {
  const nodes = Array.from(
    { length: 49 },
    (_, index) => `Capacity Node ${String(index + 1).padStart(3, "0")}`,
  );
  return [marker, "Deployment Pipeline", ...nodes].join(" ");
}

async function createProject(
  page: Page,
  name: string,
): Promise<CreatedProject> {
  await openNewProjectDialog(page);
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();

  return { id: idAfter("projects", page.url()), settingsUrl: page.url() };
}

async function openProjectSection(
  page: Page,
  projectName: string,
  section: "Documents" | "Tables" | "Graph" | "Settings",
): Promise<void> {
  await page
    .getByRole("list", { name: `${projectName} sections` })
    .getByRole("link", { name: section, exact: true })
    .click();
}

async function createDocument(
  page: Page,
  title: string,
  body: string,
  heading = false,
): Promise<CreatedDocument> {
  await page.getByRole("button", { name: "New document" }).click();
  const createDialog = page.getByRole("dialog", { name: "New document" });
  await createDialog.getByLabel("Title").fill(title);
  await createDialog
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Document content" }),
  ).toBeVisible();

  const url = page.url();
  const id = idAfter("documents", url);
  const editor = page.getByRole("textbox", { name: "Document content" });
  const paragraphs = body.split("\n\n");
  await editor.fill(paragraphs[0] ?? "");
  if (heading) {
    await expectDocumentToolbar(page);
    await runToolbarCommand(page, "Heading 2", /^Text style/);
    await expect(
      editor.getByRole("heading", {
        name: paragraphs[0],
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
  }
  for (const paragraph of paragraphs.slice(1)) {
    await editor.press("End");
    await editor.press("Enter");
    await editor.pressSequentially(paragraph);
    await expect(editor).toContainText(paragraph);
  }

  await saveDocument(page);
  await expect(
    page.getByRole("textbox", { name: "Document title" }),
  ).toHaveValue(title);
  return { id, url };
}

async function returnToDocuments(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "breadcrumb" })
    .getByRole("link", { name: "Documents", exact: true })
    .click();
}

async function buildKnowledgeAndExpectReady(
  page: Page,
  project: CreatedProject,
): Promise<void> {
  await page.goto(project.settingsUrl);
  await expect(
    page.getByText("Knowledge index", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Rebuild knowledge" }).click();
  await page
    .getByRole("dialog", { name: "Rebuild knowledge index?" })
    .getByRole("button", { name: "Request rebuild" })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Rebuild accepted for generation",
    }),
  ).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(3, {
    timeout: 120_000,
  });
}

async function openKnowledgeSearch(page: Page): Promise<{
  dialog: Locator;
  input: Locator;
}> {
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Search knowledge" });
  const input = dialog.getByRole("combobox", { name: "Search knowledge" });
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  return { dialog, input };
}

async function selectSearchProject(
  page: Page,
  dialog: Locator,
  projectName: string,
): Promise<void> {
  await dialog.getByRole("button", { name: /^Search scope:/ }).click();
  await page
    .getByRole("menuitemcheckbox", { name: projectName, exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByRole("button", { name: "Search scope: 1 project" }),
  ).toBeVisible();
}

test.describe.serial("phase 3 knowledge UI", () => {
  test("connects search, section navigation, graph, access, rebuild, and retry", async ({
    page,
    browser,
  }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await login(page, "owner@weaver.local");

    const primary = await createProject(page, PRIMARY_PROJECT);
    await openProjectSection(page, PRIMARY_PROJECT, "Documents");
    const deploymentGuide = await createDocument(
      page,
      DEPLOYMENT_GUIDE,
      "Deployment\n\nThe Deployment Pipeline deploys approved builds to Production.",
      true,
    );
    for (const [title, marker] of CAPACITY_DOCUMENTS) {
      await returnToDocuments(page);
      await createDocument(page, title, capacitySource(marker));
    }

    await openProjectSection(page, PRIMARY_PROJECT, "Tables");
    await page.getByRole("button", { name: "New table" }).click();
    const tableDialog = page.getByRole("dialog", { name: "New table" });
    await tableDialog.getByLabel("Title").fill(DEPLOYMENT_TABLE);
    await tableDialog.getByRole("button", { name: "Create table" }).click();
    await expect(
      page.getByRole("grid", { name: `${DEPLOYMENT_TABLE} table grid` }),
    ).toBeVisible();
    const deploymentTableUrl = page.url();

    const secondary = await createProject(page, SECONDARY_PROJECT);
    await openProjectSection(page, SECONDARY_PROJECT, "Documents");
    await createDocument(
      page,
      KEYWORD_RUNBOOK,
      "Keyword fallback\n\nUse keyword-only search when semantic search is unavailable.",
      true,
    );
    await returnToDocuments(page);
    await createDocument(
      page,
      SECOND_DEPLOYMENT,
      "Deployment Pipeline deploys to Production",
    );

    await buildKnowledgeAndExpectReady(page, primary);
    await buildKnowledgeAndExpectReady(page, secondary);

    const { dialog: palette, input: searchInput } =
      await openKnowledgeSearch(page);
    await searchInput.fill("Deployment");
    const documentsGroup = palette.getByRole("group", { name: "Documents" });
    const tablesGroup = palette.getByRole("group", { name: "Tables" });
    const entitiesGroup = palette.getByRole("group", { name: "Entities" });
    await expect(documentsGroup).toBeVisible();
    await expect(tablesGroup).toBeVisible();
    await expect(entitiesGroup).toBeVisible();
    await expect(
      tablesGroup.getByRole("option", { name: new RegExp(DEPLOYMENT_TABLE) }),
    ).toBeVisible();

    const allOptions = palette.getByRole("option");
    await searchInput.press("End");
    await expect(allOptions.last()).toHaveAttribute("aria-selected", "true");
    await searchInput.press("Home");
    await expect(allOptions.first()).toHaveAttribute("aria-selected", "true");
    await searchInput.press("ArrowDown");
    await expect(allOptions.nth(1)).toHaveAttribute("aria-selected", "true");
    await searchInput.press("ArrowUp");
    await expect(allOptions.first()).toHaveAttribute("aria-selected", "true");

    const tableOption = tablesGroup.getByRole("option", {
      name: new RegExp(DEPLOYMENT_TABLE),
    });
    await tableOption.focus();
    await expect(tableOption).toHaveAttribute("aria-selected", "true");
    await searchInput.focus();
    await searchInput.press("Enter");
    await expect(page).toHaveURL(deploymentTableUrl);

    const searchTrigger = page.getByRole("button", {
      name: "Search knowledge",
    });
    await searchTrigger.click();
    await expect(
      page.getByRole("dialog", { name: "Search knowledge" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(searchTrigger).toBeFocused();

    const scopedSearch = await openKnowledgeSearch(page);
    await scopedSearch.input.fill("Deployment");
    await expect(
      scopedSearch.dialog.getByRole("group", { name: "Documents" }),
    ).toBeVisible();
    await selectSearchProject(page, scopedSearch.dialog, SECONDARY_PROJECT);
    const scopedDocuments = scopedSearch.dialog.getByRole("group", {
      name: "Documents",
    });
    await expect(
      scopedDocuments.getByRole("option", {
        name: new RegExp(SECOND_DEPLOYMENT),
      }),
    ).toBeVisible();
    await expect(
      scopedSearch.dialog.getByRole("option", {
        name: new RegExp(DEPLOYMENT_GUIDE),
      }),
    ).toHaveCount(0);

    await scopedSearch.dialog
      .getByRole("button", { name: "Search scope: 1 project" })
      .click();
    await page
      .getByRole("menuitemcheckbox", {
        name: "All accessible projects",
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    await expect(
      scopedSearch.dialog.getByRole("button", {
        name: "Search scope: All projects",
      }),
    ).toBeVisible();

    await scopedSearch.input.fill("keyword-only");
    await expect(
      scopedSearch.dialog.getByText("Semantic search unavailable", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      scopedSearch.dialog.getByRole("option", {
        name: new RegExp(KEYWORD_RUNBOOK),
      }),
    ).toBeVisible();

    await scopedSearch.input.fill("Deployment");
    await scopedSearch.dialog
      .getByRole("option", { name: new RegExp(DEPLOYMENT_GUIDE) })
      .click();
    await expect(page).toHaveURL(/section=section-deployment/);
    const deploymentHeading = page.getByRole("heading", {
      name: "Deployment",
      exact: true,
      level: 2,
    });
    await expect(page.locator("[data-document-title]")).toBeFocused();
    await expect(deploymentHeading).not.toBeFocused();
    await expect(deploymentHeading).toHaveAttribute(
      "data-section-highlight",
      "true",
    );
    await expect(
      page.getByRole("textbox", { name: "Document title", exact: true }),
    ).toHaveValue(DEPLOYMENT_GUIDE);

    await page.goto(deploymentGuide.url);
    const sectionEditor = page.getByRole("textbox", {
      name: "Document content",
      exact: true,
    });
    await expect(sectionEditor).toBeVisible();
    const originalSectionEditor = await sectionEditor.elementHandle();
    await page
      .getByRole("button", { name: "View Markdown source", exact: true })
      .click();
    const sectionSource = page
      .getByRole("region", { name: "Document workspace" })
      .getByRole("region", { name: "Markdown source", exact: true });
    await expect(sectionSource).toBeVisible();
    await expect(sectionSource).toBeFocused();
    await expect(sectionSource.getByRole("heading")).toHaveCount(0);
    await expect(
      sectionSource.getByRole("textbox", {
        name: "Document Markdown source",
        exact: true,
      }),
    ).toBeEditable();
    const sameDocumentSearch = await openKnowledgeSearch(page);
    await sameDocumentSearch.input.fill("Deployment");
    await sameDocumentSearch.dialog
      .getByRole("option", { name: new RegExp(DEPLOYMENT_GUIDE) })
      .click();
    await expect(page).toHaveURL(/section=section-deployment/);
    await expect(sameDocumentSearch.dialog).toBeHidden();
    await expect(sectionSource).toBeHidden();
    await expect(sectionEditor).toBeVisible();
    await expect(deploymentHeading).toHaveAttribute("id", "section-deployment");
    await expect(deploymentHeading).toHaveAttribute(
      "data-section-highlight",
      "true",
    );
    await expect(page.locator("[data-document-title]")).toBeFocused();
    await expect(sectionEditor).not.toBeFocused();
    await expect(
      page.getByRole("button", { name: "Save document", exact: true }),
    ).toBeHidden();
    expect(
      await originalSectionEditor.evaluate((element) => element.isConnected),
    ).toBe(true);
    await originalSectionEditor.dispose();

    await page.getByRole("button", { name: "Document actions" }).click();
    await page.getByRole("menuitem", { name: "Explore graph" }).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/projects/${primary.id}/graph\\?document=${deploymentGuide.id}`,
      ),
    );
    await expect(
      page.getByRole("heading", { name: "Entities from source document" }),
    ).toBeVisible();
    const seedFocus = page.getByRole("button", {
      name: new RegExp(
        `^Focus Deployment Pipeline, Process in ${escapeRegex(PRIMARY_PROJECT)}\\. Entity ID`,
      ),
    });
    await expect(seedFocus).toBeVisible();
    const seedLabel = await seedFocus.getAttribute("aria-label");
    const primaryDeploymentEntityId = seedLabel?.match(UUID_PATTERN)?.[0];
    expect(primaryDeploymentEntityId).toBeTruthy();
    await seedFocus.click();
    await expect(page).toHaveURL(
      new RegExp(
        `/projects/${primary.id}/graph\\?focus=${primaryDeploymentEntityId}`,
      ),
    );

    const primaryGraph = page.getByRole("region", {
      name: `${PRIMARY_PROJECT} knowledge graph`,
    });
    await expect(primaryGraph).toBeVisible();
    const graphCanvas = page
      .getByRole("region", { name: "Visual graph", exact: true })
      .locator("canvas")
      .first();
    await expect(graphCanvas).toBeVisible();
    await expect
      .poll(async () => (await graphCanvas.boundingBox())?.height ?? 0)
      .toBeGreaterThan(300);
    await expect(
      page.getByRole("heading", { name: "Graph outline" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Select Production,/ }),
    ).toBeVisible();
    const deploymentSelection = page.getByRole("button", {
      name: /^Select Deployment Pipeline,.*Entity ID/,
    });
    await deploymentSelection.click();
    const wideDetails = page.getByRole("complementary", {
      name: "Graph details",
    });
    await expect(
      wideDetails.getByRole("heading", {
        name: "Deployment Pipeline",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      wideDetails.getByRole("region", { name: /^Active mentions/ }),
    ).toContainText(DEPLOYMENT_GUIDE);

    await expect(
      primaryGraph.getByText("The focused graph was truncated by the server.", {
        exact: true,
      }),
    ).toBeVisible();

    const capacityExpansion = page.getByRole("button", {
      name: /^Expand Capacity Node 001,.*Entity ID/,
    });
    await expect(capacityExpansion).toBeEnabled();
    await capacityExpansion.click();
    await expect(
      primaryGraph.getByRole("status").filter({
        hasText: "Capacity Node 001 was expanded.",
      }),
    ).toContainText("Capacity Node 001 was expanded.");
    await expect(
      primaryGraph.getByText(
        "The graph reached the 100-entity or 200-relation canvas limit.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(capacityExpansion).toBeDisabled();
    await expect(
      page.getByRole("button", {
        name: /^Expand Deployment Pipeline,.*Entity ID/,
      }),
    ).toBeDisabled();

    await expect(primaryGraph).not.toContainText(
      /complete graph|all graph items loaded/i,
    );

    const relationSelection = page.getByRole("button", {
      name: /^Select Deployment Pipeline DEPLOYS TO Production\./,
    });
    await relationSelection.click();
    await expect(
      wideDetails.getByRole("heading", {
        name: "Deployment Pipeline DEPLOYS TO Production",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      wideDetails.getByRole("region", { name: /^Active evidence/ }),
    ).toContainText("approved builds");
    const provenanceLink = wideDetails.getByRole("link", {
      name: new RegExp(DEPLOYMENT_GUIDE),
    });
    await expect(provenanceLink).toBeVisible();
    const primaryGraphUrl = page.url();
    await provenanceLink.click();
    await expect(page).toHaveURL(/section=section-deployment/);
    await expect(page.locator("[data-document-title]")).toBeFocused();
    await expect(deploymentHeading).not.toBeFocused();

    const projectSwitchSearch = await openKnowledgeSearch(page);
    await projectSwitchSearch.input.fill("Deployment Pipeline");
    await expect(
      projectSwitchSearch.dialog.getByRole("group", { name: "Entities" }),
    ).toBeVisible();
    await selectSearchProject(
      page,
      projectSwitchSearch.dialog,
      SECONDARY_PROJECT,
    );
    await projectSwitchSearch.dialog
      .getByRole("group", { name: "Entities" })
      .getByRole("option", {
        name: new RegExp(
          `Deployment Pipeline\\s+${escapeRegex(SECONDARY_PROJECT)}`,
        ),
      })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${secondary.id}/graph\\?focus=`),
    );
    const secondaryGraph = page.getByRole("region", {
      name: `${SECONDARY_PROJECT} knowledge graph`,
    });
    await expect(secondaryGraph).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: new RegExp(
          `^Select Deployment Pipeline, Process in ${escapeRegex(SECONDARY_PROJECT)}`,
        ),
      }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Graph outline" })
        .getByText(PRIMARY_PROJECT),
    ).toHaveCount(0);

    await page.goto(primaryGraphUrl);
    await expect(primaryGraph).toBeVisible();
    await expect(relationSelection).toBeVisible();
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(
      page.getByRole("heading", { name: "Graph outline" }),
    ).toBeVisible();

    const filtersTrigger = page.getByRole("button", {
      name: "Filters",
      exact: true,
    });
    await filtersTrigger.click();
    const filtersDrawer = page.getByRole("dialog", { name: "Graph filters" });
    await expect(filtersDrawer).toBeVisible();
    await expect(
      filtersDrawer.getByRole("button", { name: "Projects: 1 project" }),
    ).toBeVisible();
    await filtersDrawer.getByRole("button", { name: "Close" }).click();
    await expect(filtersDrawer).toBeHidden();
    await filtersTrigger.click();
    await expect(
      filtersDrawer.getByRole("button", { name: "Projects: 1 project" }),
    ).toBeVisible();
    await filtersDrawer.getByRole("button", { name: "Close" }).click();

    await relationSelection.focus();
    await relationSelection.press("Enter");
    const detailsDrawer = page.getByRole("dialog", { name: "Graph details" });
    await expect(detailsDrawer).toBeVisible();
    await expect(
      detailsDrawer.getByRole("heading", {
        name: "Deployment Pipeline DEPLOYS TO Production",
      }),
    ).toBeFocused();
    await detailsDrawer.getByRole("button", { name: "Close" }).click();
    await expect(relationSelection).toBeFocused();
    await expect(relationSelection).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(detailsDrawer).toBeVisible();
    await expect(
      detailsDrawer.getByRole("heading", {
        name: "Deployment Pipeline DEPLOYS TO Production",
      }),
    ).toBeVisible();
    await detailsDrawer.getByRole("button", { name: "Close" }).click();
    await expect(relationSelection).toHaveAttribute("aria-current", "true");

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(primary.settingsUrl);
    await page.getByRole("button", { name: "Add member" }).click();
    const addMemberDialog = page.getByRole("dialog", { name: "Add member" });
    await addMemberDialog.getByLabel("Email").fill("viewer@weaver.local");
    await addMemberDialog.getByLabel("Role").click();
    await page.getByRole("option", { name: "Viewer", exact: true }).click();
    await addMemberDialog
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: "viewer@weaver.local" }),
    ).toBeVisible();

    const viewerContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const viewerPage = await viewerContext.newPage();
    await login(viewerPage, "viewer@weaver.local");
    await viewerPage.goto(primaryGraphUrl);
    const viewerGraph = viewerPage.getByRole("region", {
      name: `${PRIMARY_PROJECT} knowledge graph`,
    });
    await expect(viewerGraph).toBeVisible();
    await expect(
      viewerGraph.getByText("Knowledge ready", { exact: true }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("heading", { name: "Graph outline" }),
    ).toBeVisible();
    await viewerPage
      .getByRole("button", {
        name: /^Select Deployment Pipeline DEPLOYS TO Production\./,
      })
      .click();
    await expect(
      viewerPage
        .getByRole("complementary", { name: "Graph details" })
        .getByRole("link", { name: new RegExp(DEPLOYMENT_GUIDE) }),
    ).toBeVisible();
    await viewerPage.goto(primary.settingsUrl);
    await expect(
      viewerPage.getByRole("heading", {
        name: PRIMARY_PROJECT,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      viewerPage.getByText("Knowledge index", { exact: true }),
    ).toHaveCount(0);
    await expect(
      viewerPage.getByRole("button", { name: "Rebuild knowledge" }),
    ).toHaveCount(0);
    await expect(
      viewerPage.getByRole("button", { name: "Retry failed work" }),
    ).toHaveCount(0);
    await viewerContext.close();

    await page.goto(primary.settingsUrl);
    const activeGeneration = page.getByRole("region", {
      name: "Active generation",
    });
    const buildingGeneration = page.getByRole("region", {
      name: "Building generation",
    });
    await expect(activeGeneration).toBeVisible();
    await expect(
      buildingGeneration.getByText("None", { exact: true }),
    ).toBeVisible();
    const activeGenerationSummary = activeGeneration.getByText(
      /\d+ ready · \d+ failed · \d+ total/,
    );
    await expect(activeGenerationSummary).toBeVisible();
    const activeGenerationValue = await activeGenerationSummary.textContent();
    expect(activeGenerationValue).toBeTruthy();
    await page.getByRole("button", { name: "Rebuild knowledge" }).click();
    const rebuildDialog = page.getByRole("dialog", {
      name: "Rebuild knowledge index?",
    });
    await expect(rebuildDialog).toContainText("Git content is untouched");
    await expect(rebuildDialog).toContainText("shadow generation builds");
    await expect(rebuildDialog).toContainText("incur cost");
    await rebuildDialog
      .getByRole("button", { name: "Request rebuild" })
      .click();
    const rebuildReceipt = page.getByRole("status").filter({
      hasText: "Rebuild accepted for generation",
    });
    await expect(rebuildReceipt).toBeVisible();
    await expect(rebuildReceipt).toContainText(
      "The current active generation remains available while it builds.",
    );
    await expect(
      buildingGeneration.getByText(/\d+ ready · \d+ failed · \d+ total/),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      activeGeneration.getByText(activeGenerationValue!, { exact: true }),
    ).toBeVisible();
    await expect(
      buildingGeneration.getByText("None", { exact: true }),
    ).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(3, {
      timeout: 120_000,
    });
    await expect(rebuildReceipt).toBeVisible();
    await expect(activeGeneration).toBeVisible();

    await openProjectSection(page, PRIMARY_PROJECT, "Documents");
    await createDocument(
      page,
      RETRY_DOCUMENT,
      "retry-once Deployment Pipeline Production",
    );
    await page.goto(primary.settingsUrl);
    // Readiness is per layer: a failed extraction degrades only the graph layer.
    await expect(page.getByText("Degraded", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(
      page.getByRole("heading", { name: "Recent failures" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry failed work" }).click();
    const retryDialog = page.getByRole("dialog", {
      name: "Retry failed knowledge work?",
    });
    await expect(retryDialog).toContainText("failed AI work may run again");
    await retryDialog
      .getByRole("button", { name: "Retry failed work" })
      .click();
    const retryReceipt = page.getByRole("status").filter({
      hasText: "1 failed item accepted for retry.",
    });
    await expect(retryReceipt).toBeVisible();
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(3, {
      timeout: 120_000,
    });
    await expect(retryReceipt).toBeVisible();
  });
});
