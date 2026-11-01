import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { login, openNewProjectDialog, mcpClient } from "./helpers";

const MCP_URL = process.env.WEAVER_MCP_RESOURCE_URL!;
const CLIENT_ID = "e2e-mcp-client";
const REDIRECT_URI = "http://127.0.0.1:4545/callback";
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

test.describe("MCP runtime", () => {
  test("an API key created in the UI drives the running mcp-server and its write lands in the app", async ({
    page,
  }) => {
    await login(page, "owner@weaver.local");
    await openNewProjectDialog(page);
    await page
      .getByRole("dialog", { name: "New project" })
      .getByLabel("Name")
      .fill("MCP Project");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("MCP Project").first()).toBeVisible();

    await page.getByRole("button", { name: "User menu" }).first().click();
    await page.getByRole("menuitem", { name: "API keys" }).click();
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByLabel("Name").fill("MCP e2e");
    await page.getByLabel("Edit content directly, without review").check();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const secret = await page
      .getByRole("textbox", { name: "New API key" })
      .inputValue();
    await page.getByRole("button", { name: "I have copied the key" }).click();

    const client = await mcpClient(secret);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("read_document");
    expect(tools).toContain("create_document");
    const projects = (
      await client.callTool({ name: "list_projects", arguments: {} })
    ).structuredContent as { projects: Array<{ id: string; name: string }> };
    const project = projects.projects.find((p) => p.name === "MCP Project");
    expect(project).toBeTruthy();
    const created = (
      await client.callTool({
        name: "create_document",
        arguments: {
          projectId: project!.id,
          folderPath: [],
          title: "From MCP",
          markdown: "# From MCP\n\nWritten by a client.\n",
          idempotencyKey: `e2e-${Date.now()}`,
          summary: "Create a page over MCP",
        },
      })
    ).structuredContent as { commitSha: string; replayed: boolean };
    expect(created.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(created.replayed).toBe(false);
    await client.close();

    await page.getByRole("button", { name: "Switch project" }).click();
    await page.getByRole("menuitem", { name: "MCP Project" }).click();
    await expect(page.getByText("From MCP").first()).toBeVisible();
  });

  test("a browser OAuth consent yields a token the mcp-server accepts until it is revoked", async ({
    page,
    request,
  }) => {
    await login(page, "editor@weaver.local");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "mcp:use content:read",
      state: "e2e-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_URL,
    });
    await page.route(`${REDIRECT_URI}*`, (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "ok" }),
    );
    const callback = page.waitForURL((url) =>
      url.href.startsWith(REDIRECT_URI),
    );
    await page.goto(`/api/auth/oauth2/authorize?${query}`);
    await expect(
      page.getByText(/Allow E2E MCP client to access Weaver\?/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Allow access" }).click();
    await callback;
    const callbackUrl = new URL(page.url());
    expect(callbackUrl.searchParams.get("state")).toBe("e2e-state");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await request.post(`${BASE_PATH}/api/auth/oauth2/token`, {
      form: {
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        resource: MCP_URL,
      },
    });
    expect(token.status()).toBe(200);
    const { access_token } = (await token.json()) as { access_token: string };

    const client = await mcpClient(access_token);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("read_document");
    expect(tools).not.toContain("create_document");
    await client.close();

    await page.goto(`${BASE_PATH}/account/connected-apps`);
    await expect(
      page.getByRole("heading", { name: "Connected apps" }),
    ).toBeVisible();
    await expect(
      page.getByRole("row", { name: /E2E MCP client/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Revoke E2E MCP client" }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText("No connected apps yet.")).toBeVisible();

    const denied = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
        authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "e2e",
              version: "0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(denied.status).toBe(401);
  });
});
