import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const mockBaseUrl = `http://127.0.0.1:${process.env.WEAVER_E2E_AI_PORT ?? "4010"}`;

test.describe.serial("administration › Settings › AI", () => {
  test("non-admins have no Administration navigation and get 404", async ({
    page,
  }) => {
    await login(page, "owner@weaver.local");
    await expect(page.getByRole("link", { name: "AI" })).toHaveCount(0);
    const response = await page.goto("/admin/settings/ai");
    expect(response?.status()).toBe(404);
  });

  test("admin sees seeded routing, creates and tests a connection and model, then deletes them", async ({
    page,
  }) => {
    await login(page, "admin@weaver.local");
    await page.goto("/admin/settings");
    await page
      .getByRole("navigation", { name: "Administration settings" })
      .getByRole("link", { name: "AI", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Routes" })).toBeVisible();
    await expect(page.getByText("E2E mock provider")).toBeVisible();
    for (const label of [
      "Assistant",
      "Knowledge extraction",
      "Knowledge embeddings",
    ]) {
      await expect(
        page.getByTestId(`route-${label}`).getByText("Ready"),
      ).toBeVisible();
    }

    const connectionsRegion = page.getByRole("region", {
      name: "LLM connections",
    });
    const addConnectionButton = page.getByRole("button", {
      name: "Add connection",
    });
    await addConnectionButton.click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(addConnectionButton).toBeFocused();
    await addConnectionButton.click();
    await page.getByLabel("Name").fill("Second mock");
    await page.getByLabel("Provider").click();
    await page.getByRole("option", { name: "LM Studio" }).click();
    await expect(page.getByLabel("Endpoint")).toHaveValue(
      "http://127.0.0.1:1234",
    );
    expect(
      await page.getByLabel("API key").getAttribute("required"),
    ).toBeNull();
    await page.getByLabel("Provider").click();
    await page
      .getByRole("option", { name: "OpenAI-compatible endpoint" })
      .click();
    await expect(page.getByLabel("Endpoint")).toHaveValue("");
    await page.getByLabel("Endpoint").fill(mockBaseUrl);
    await page.getByLabel("API key").fill("second-key");
    await page.getByRole("button", { name: "Save connection" }).click();
    const card = page.getByTestId("connection-Second mock");
    await expect(card).toBeVisible();

    // Saving runs the connection test and opens the discovered models.
    const importDialog = page.getByRole("dialog", { name: "Import models" });
    await expect(importDialog).toBeVisible();
    await expect(
      page.getByText("Listed 2 model(s)", { exact: true }),
    ).toBeVisible();
    await expect(
      importDialog.getByRole("checkbox", { name: "Import e2e-extraction" }),
    ).toBeChecked();
    await expect(
      importDialog.getByRole("checkbox", { name: "Import e2e-embedding" }),
    ).toBeChecked();
    await importDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(addConnectionButton).toBeFocused();
    await expect(card.getByText("second-key")).toHaveCount(0);

    const testButton = card.getByRole("button", { name: "Test connection" });
    await testButton.click();
    await expect(importDialog).toBeVisible();
    await importDialog.getByLabel("Filter models").fill("extraction");
    await expect(
      importDialog.getByRole("checkbox", { name: "Import e2e-embedding" }),
    ).toHaveCount(0);
    await importDialog.getByLabel("Filter models").fill("");
    await importDialog
      .getByRole("checkbox", { name: "Import e2e-embedding" })
      .uncheck();
    await importDialog.getByRole("button", { name: "Import 1 model" }).click();
    await expect(
      page.getByText("Imported 1 model", { exact: true }),
    ).toBeVisible();
    await expect(testButton).toBeFocused();
    const importedRow = card.getByRole("row", { name: /e2e-extraction/ });
    await expect(importedRow).toContainText("32768");
    await expect(importedRow).toContainText("4096");

    const addModelButton = card.getByRole("button", { name: "Add model" });
    await addModelButton.click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(addModelButton).toBeFocused();
    await addModelButton.click();
    await page.getByLabel("Provider model id").fill("e2e-embedding");
    await page.getByLabel("Display name").fill("Second embedding");
    await page.getByLabel("Context window").fill("-1");
    await page.getByRole("checkbox", { name: "Embeddings" }).check();
    await page.getByLabel("Embedding dimensions").fill("16001");
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(
      page.getByText("Must be a non-negative integer"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Embedding models must declare dimensions from 1 to 16000",
      ),
    ).toBeVisible();
    await page.getByLabel("Context window").fill("");
    await page.getByLabel("Embedding dimensions").fill("1536");
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(addModelButton).toBeFocused();
    const row = card.getByRole("row", { name: /Second embedding/ });
    await row.getByRole("button", { name: "Test model" }).click();
    await expect(
      page.getByText("Embedded 1 input (1536 dimensions)", { exact: true }),
    ).toBeVisible();

    const deleteModelButton = row.getByRole("button", {
      name: "Delete model",
    });
    await deleteModelButton.click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(deleteModelButton).toBeFocused();
    await deleteModelButton.click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(
      card.getByRole("row", { name: /Second embedding/ }),
    ).toHaveCount(0);
    await expect(connectionsRegion).toBeFocused();
    await card.getByRole("button", { name: "Delete connection" }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("connection-Second mock")).toHaveCount(0);
    await expect(connectionsRegion).toBeFocused();
    await expect(page.getByText("E2E mock provider")).toBeVisible();
  });
});
