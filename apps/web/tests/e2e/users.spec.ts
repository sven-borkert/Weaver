import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

const NEW_EMAIL = "e2e-created@test.local";
const NEW_NAME = "E2E Created";
const CHOSEN_PASSWORD = "chosen-password-12";
const DEACTIVATE_REASON = "end of engagement";

test.describe("user management", () => {
  test("an admin creates a user who must change their password, then deactivates them", async ({
    page,
  }) => {
    await login(page, "admin@weaver.local");
    await page.getByRole("link", { name: "Users" }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();

    // --- Create the user ---
    await page.getByRole("button", { name: "Create user" }).click();
    await page.getByLabel("Email").fill(NEW_EMAIL);
    await page.getByLabel("Name").fill(NEW_NAME);
    // Entry is masked and confirmed; a mismatch keeps the dialog open.
    const passwordField = page.getByLabel("Password", { exact: true });
    const confirmField = page.getByLabel("Confirm password");
    await expect(passwordField).toHaveAttribute("type", "password");
    await expect(confirmField).toHaveAttribute("type", "password");
    await passwordField.fill("typed-password-12");
    await confirmField.fill("typed-password-13");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("Passwords do not match")).toBeVisible();

    // A generated password stays masked in the form and is revealed once after creation.
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(passwordField).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    // --- The one-time reveal really is one-time ---
    // Scoped to the reveal dialog: a closing "Create user" dialog can still be mounted mid-exit-transition and also has a "Password" field.
    const revealDialog = page.getByRole("dialog", {
      name: "Copy the new user's password",
    });
    await expect(revealDialog).toBeVisible();
    const revealedField = revealDialog.getByLabel("Password", {
      exact: true,
    });
    await expect(revealedField).toHaveValue(/^.{20}$/);
    const initialPassword = await revealedField.inputValue();
    await revealDialog.getByRole("button", { name: "Done" }).click();
    // No dialog left open at all — the input holding the plaintext is gone, not just hidden behind a closed reveal.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect(page.getByRole("cell", { name: NEW_EMAIL })).toBeVisible();
    const userLink = page.getByRole("link", { name: NEW_NAME, exact: true });
    await expect(userLink).toBeVisible();

    await logout(page);

    // --- The forced-change redirect does not loop: the new user reaches /account/password and can actually submit the form from there ---
    await login(page, NEW_EMAIL, initialPassword);
    await expect(page).toHaveURL(/\/account\/password$/);
    await expect(page.getByRole("status")).toHaveText(
      "An administrator set this password. You must change it before continuing.",
    );

    await page.getByLabel("Current password").fill(initialPassword);
    await page
      .getByLabel("New password", { exact: true })
      .fill(CHOSEN_PASSWORD);
    await page.getByLabel("Confirm new password").fill(CHOSEN_PASSWORD);
    await page
      .getByRole("button", { name: "Change password", exact: true })
      .click();

    // Positive proof the app is reachable afterward, not just "not stuck" —
    // a new user lands in their freshly created personal workspace.
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/documents$/);
    await expect(page).not.toHaveURL(/\/account\/password$/);

    // --- Sign-out stays reachable from the forced-change page (proven above by reaching the dashboard) and generally, before the admin returns ---
    await logout(page);

    // A fresh sign-in (not the session that made the change) proves CHOSEN_PASSWORD is a real credential and mustChangePassword cleared — also what makes the final deactivation-rejection assertion non-vacuous.
    await login(page, NEW_EMAIL, CHOSEN_PASSWORD);
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/documents$/);
    await expect(page).not.toHaveURL(/\/account\/password$/);
    await logout(page);

    // --- The admin deactivates them ---
    await login(page, "admin@weaver.local");
    await page.getByRole("link", { name: "Users" }).click();
    await page.getByRole("link", { name: NEW_NAME, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: NEW_NAME, exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Deactivate", exact: true }).click();
    const deactivateDialog = page.getByRole("dialog", {
      name: "Deactivate account",
    });
    await expect(deactivateDialog).toBeVisible();
    await deactivateDialog.getByLabel("Reason").fill(DEACTIVATE_REASON);
    await deactivateDialog
      .getByRole("button", { name: "Deactivate", exact: true })
      .click();

    await expect(
      page.getByText(`Deactivated: ${DEACTIVATE_REASON}.`),
    ).toBeVisible();

    await logout(page);

    // --- Deactivation is a real kill switch: the sign-in above already proved this exact password worked, so the rejection below is meaningful, not vacuous. ---
    await page.goto("/login");
    await page.getByLabel("Email").fill(NEW_EMAIL);
    await page.getByLabel("Password").fill(CHOSEN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Invalid credentials")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
