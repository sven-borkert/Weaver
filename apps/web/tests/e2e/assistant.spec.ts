import { expect, test, type Locator, type Page } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";
import { saveDocument } from "./document-helpers";

/** The worker leases through pg-boss and the mock provider deliberately stalls. */
const WORKER_TIMEOUT = 120_000;
const ASSISTANT_SHORTCUT =
  process.platform === "darwin" ? "Meta+j" : "Control+j";

/** Captured in the first test and reused by the Viewer test below. */
let documentUrl = "";
let conversationUrl = "";

const panel = (page: Page) =>
  page.getByRole("dialog", { name: "Assistant", exact: true });
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message the assistant" });
const proposalCard = (page: Page) => panel(page).locator("[data-proposal-id]");
/** The transcript's settled answer, not the sr-only live region that repeats it. */
const answer = (scope: Locator, text: string) =>
  scope.getByRole("paragraph").filter({ hasText: text });

async function send(page: Page, text: string) {
  await expect(composer(page)).toBeEnabled();
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

async function openNewConversation(page: Page) {
  await page.keyboard.press(ASSISTANT_SHORTCUT);
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "New", exact: true }).click();
  await expect(composer(page)).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("converse from a document page with scope, streaming, citations, and proposals", async ({
  page,
}) => {
  // ~21s alone but 29.8–30.3s under the suite's parallel workers: give it
  // headroom over Playwright's default 30s rather than let contention flake it.
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1700, height: 1000 });
  await login(page, "owner@weaver.local");

  // Creating a project lands on its settings page, where the Viewer used by
  // the second test is added.
  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill("Assistant E2E");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Assistant E2E" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByLabel("Email").fill("viewer@weaver.local");
  // exact: the substring "Add" also matches the "Add member" trigger.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "viewer@weaver.local" }),
  ).toBeVisible();

  await page
    .getByRole("list", { name: "Assistant E2E sections" })
    .getByRole("link", { name: "Documents", exact: true })
    .click();
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Title").fill("Runbook");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Document content" })
    .fill("Run the deploy pipeline.");
  await saveDocument(page);
  await expect(
    page
      .getByRole("main")
      .getByLabel("Document content")
      .getByText("Run the deploy"),
  ).toBeVisible();
  documentUrl = page.url();

  // ⌘J opens the centered dialog; a new conversation defaults to "Focus on this document".
  await openNewConversation(page);
  await expect(
    panel(page).getByRole("button", {
      name: /^Scope: Focus on this document · Runbook$/,
    }),
  ).toBeVisible();

  // A plain answer streams in and settles.
  await send(page, "say something plain");
  await expect(
    answer(panel(page), "Here is a plain answer with no sources."),
  ).toBeVisible({ timeout: WORKER_TIMEOUT });
  await expect(composer(page)).toBeEnabled();
  // The sent message carries the scope it was sent with.
  await expect(
    panel(page).getByText("Focus on this document", { exact: true }),
  ).toBeVisible();

  // The persona reads the focused document, and the citation links back to it.
  await send(page, "cite the runbook");
  const sources = panel(page).getByRole("list", { name: "Sources" });
  const citation = sources.getByRole("link", { name: "Runbook" });
  await expect(citation).toBeVisible({ timeout: WORKER_TIMEOUT });
  await expect(composer(page)).toBeEnabled();
  await expect(citation).toHaveAttribute("href", new URL(documentUrl).pathname);

  // A proposal renders its diff; Accept commits it and the document changes.
  await send(page, "propose an addition");
  await expect(
    answer(panel(page), "I have proposed an edit; review it below."),
  ).toBeVisible({ timeout: WORKER_TIMEOUT });
  await expect(composer(page)).toBeEnabled();
  const card = proposalCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText("Document edit")).toBeVisible();
  await expect(
    card.getByText("Append a line noting the assistant's addition."),
  ).toBeVisible();
  await expect(
    card
      .locator('[data-line-type="add"]')
      .filter({ hasText: "Added by the assistant." }),
  ).toBeVisible();

  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card.getByText(/^Accepted · commit [0-9a-f]{7}$/)).toBeVisible();
  await panel(page).getByRole("button", { name: "Close assistant" }).click();
  // The toast (a button; the card's own link has role "link") offers the target.
  const openDocument = page.getByRole("button", { name: "Open document" });
  await expect(openDocument).toBeVisible();
  await openDocument.click();
  await expect(page).toHaveURL(documentUrl);
  // Re-read the document from the server: the commit must really have landed.
  await page.reload();
  await expect(
    page
      .getByRole("main")
      .getByRole("article")
      .locator("p", { hasText: "Added by the assistant." }),
  ).toBeVisible();
  await page.keyboard.press(ASSISTANT_SHORTCUT);
  await expect(
    proposalCard(page).locator('[data-proposal-status="accepted"]'),
  ).toBeVisible();
  await expect(
    proposalCard(page).getByText(/^Accepted · commit [0-9a-f]{7}$/),
  ).toBeVisible();

  // Closing releases the page while the run continues; reopening after reload reconnects.
  await send(page, "give me a slow answer");
  await expect(composer(page)).toBeDisabled();
  await panel(page).getByRole("button", { name: "Close assistant" }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page.getByRole("main")).toBeVisible();
  await page.reload();
  await page.keyboard.press(ASSISTANT_SHORTCUT);
  await expect(panel(page)).toBeVisible();
  await expect(composer(page)).toBeDisabled();
  await expect(panel(page).getByText(/^(Queued|Thinking)$/)).toBeVisible();
  await expect(
    answer(panel(page), "This is a slow answer that took a while."),
  ).toBeVisible({ timeout: WORKER_TIMEOUT });
  await expect(composer(page)).toBeEnabled();

  // Cancel reaches the terminal cancelled state.
  await send(page, "another slow answer please");
  await panel(page).getByRole("button", { name: "Cancel" }).click();
  await expect(panel(page).getByText("Cancelled", { exact: true })).toBeVisible(
    { timeout: WORKER_TIMEOUT },
  );
  await expect(composer(page)).toBeEnabled();

  // The full-page route shows the same conversation.
  await panel(page).getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("menuitem", { name: "Open full page" }).click();
  await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]{36}$/);
  conversationUrl = page.url();
  const fullPage = page.getByRole("region", { name: "Assistant" });
  await expect(
    answer(fullPage, "Here is a plain answer with no sources."),
  ).toBeVisible();
  await expect(
    answer(fullPage, "This is a slow answer that took a while."),
  ).toBeVisible();
  // Other specs sign in as the same owner in parallel workers, so count only
  // this project's conversation rather than the whole personal list.
  await expect(
    page
      .getByRole("list", { name: "Conversations" })
      .getByRole("button", { name: /say something plain.*Assistant E2E/ }),
  ).toHaveCount(1);
});

test("a Viewer gets no proposal, and cannot open someone else's conversation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 1000 });
  await login(page, "viewer@weaver.local");
  await page.goto(documentUrl);
  await expect(
    page
      .getByRole("main")
      .getByRole("article")
      .locator("p", { hasText: "Run the deploy" }),
  ).toBeVisible();

  // The same persona phrase that produced a card for the Owner: the model
  // calls propose_document_edit (the answer below is only streamed once that
  // tool has returned), but createProposal requires Editor, so nothing is
  // proposed. read_document still succeeds, proving the run really ran tools.
  await openNewConversation(page);
  await send(page, "propose an addition");
  await expect(
    answer(panel(page), "I have proposed an edit; review it below."),
  ).toBeVisible({ timeout: WORKER_TIMEOUT });
  await expect(composer(page)).toBeEnabled();
  await expect(
    panel(page)
      .getByRole("list", { name: "Sources" })
      .getByRole("link", { name: "Runbook" }),
  ).toBeVisible();
  await expect(proposalCard(page)).toHaveCount(0);

  // Conversations are personal: the Owner's is not readable here. React Query
  // retries the NOT_FOUND three times with backoff before the state settles.
  await page.goto(conversationUrl);
  await expect(
    page.getByText("This conversation isn’t available."),
  ).toBeVisible({ timeout: 30_000 });
});
