import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type Page } from "@playwright/test";

export async function login(
  page: Page,
  email: string,
  password = "admin1234567",
) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // A user flagged mustChangePassword lands on /account/password instead of
  // their landing project's Documents — both are a successful sign-in.
  await page.waitForURL(
    /\/projects\/[0-9a-f-]{36}\/documents$|\/account\/password$/,
  );
}

/** Opens the sidebar project switcher and its "New project" dialog trigger. */
export async function openNewProjectDialog(page: Page) {
  await page.getByRole("button", { name: "Switch project" }).click();
  await page.getByRole("button", { name: "New project" }).click();
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  // Sign-out ends with a full-document navigation; waiting for "load" can race
  // an aborted intermediate navigation, so wait for the login URL to commit.
  await page.waitForURL(/\/login/, { waitUntil: "commit" });
}

export async function mcpClient(token: string): Promise<Client> {
  const client = new Client(
    { name: "weaver-e2e", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(process.env.WEAVER_MCP_RESOURCE_URL!),
      {
        authProvider: { token: async () => token },
      },
    ),
  );
  return client;
}
