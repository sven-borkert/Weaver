import { expect, test } from "@playwright/test";
import { login, openNewProjectDialog } from "./helpers";

test("an external system submits a file with an API key and it reaches review", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page, "owner@weaver.local");

  await openNewProjectDialog(page);
  await page
    .getByRole("dialog", { name: "New project" })
    .getByLabel("Name")
    .fill("External Feed E2E");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+/);
  const projectId = /\/projects\/([0-9a-f-]+)/.exec(page.url())![1]!;

  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.getByRole("menuitem", { name: "API keys" }).click();
  await page.getByRole("button", { name: "Create key" }).click();
  await page.getByLabel("Name").fill("Feed key");
  await page
    .getByLabel("Submit files to Imports from external systems")
    .check();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const secret = await page
    .getByRole("textbox", { name: "New API key" })
    .inputValue();
  await page.getByRole("button", { name: "I have copied the key" }).click();
  await expect(
    page.getByRole("row", { name: /Feed key/ }).getByText("Import"),
  ).toBeVisible();

  const response = await request.post("/api/ingestion/external", {
    headers: { authorization: `Bearer ${secret}` },
    multipart: {
      projectId,
      label: "nightly feed",
      file: {
        name: "feed.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Feed\n\nSubmitted by an external system.\n"),
      },
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as {
    batchId: string;
    file: { id: string; fileName: string; status: string };
  };
  expect(body.file).toMatchObject({ fileName: "feed.md", status: "pending" });

  const denied = await request.post("/api/ingestion/external", {
    multipart: {
      projectId,
      file: {
        name: "x.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("x"),
      },
    },
  });
  expect(denied.status()).toBe(401);

  await page.goto(`/projects/${projectId}/imports`);
  await expect(page.getByText("External", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "nightly feed", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review feed.md" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Ready for review").first()).toBeVisible();
});
