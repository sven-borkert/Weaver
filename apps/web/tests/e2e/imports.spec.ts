import { expect, test } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";

test("upload a Markdown file, review its draft, and accept it as a document", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page, "owner@weaver.local");

  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill("Imports E2E");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("list", { name: "Imports E2E sections" })
    .getByRole("link", { name: "Imports", exact: true })
    .click();

  await page.getByLabel("Choose files to import").setInputFiles({
    name: "release-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Release notes\n\nVersion one ships imports.\n"),
  });
  await expect(
    page
      .getByRole("status")
      .getByText("Files uploaded. Processing will update below.", {
        exact: true,
      }),
  ).toBeVisible();
  const review = page.getByRole("link", { name: "Review release-notes.md" });
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Ready for review").first()).toBeVisible();
  await review.click();

  await expect(
    page.getByRole("heading", { name: "Review release-notes.md" }),
  ).toBeVisible();
  await expect(page.getByText("AI analysis skipped")).toBeVisible();
  await expect(page.getByLabel("Draft preview")).toContainText(
    "Version one ships imports.",
  );
  await page.getByLabel("Title").fill("Release notes v1");
  await page.getByRole("button", { name: "Accept", exact: true }).click();

  await page.waitForURL(/\/projects\/[0-9a-f-]+\/documents\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: "Release notes v1" }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toContainText(
    "Version one ships imports.",
  );

  await page
    .getByRole("list", { name: "Imports E2E sections" })
    .getByRole("link", { name: "Imports", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Untitled import|release-notes/ })
    .first()
    .click();
  await expect(page.getByText("Accepted").first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open release-notes.md" }),
  ).toBeVisible();
});
