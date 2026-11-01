import { fileURLToPath } from "node:url";
import { assertTestEnvironment } from "@weaver/config/testEnvironment";
import { resetTestState } from "../_reset";
import { PrismaPg } from "@prisma/adapter-pg";
import { createCredentialUser, createWeaverAuth } from "@weaver/auth";
import { PrismaClient } from "@weaver/db/client";
import { createSessionSecurityContext } from "@weaver/core/security/context";
import { loadEncryptionKeyRing } from "@weaver/core/security/encryption";
import {
  createLlmConnection,
  createLlmModel,
} from "@weaver/core/services/llmConnections";
import { setLlmRoute } from "@weaver/core/services/llmRoutes";

export default async function globalSetup() {
  assertTestEnvironment(
    process.env,
    "e2e",
    fileURLToPath(new URL("../../../../", import.meta.url)),
  );
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  const auth = createWeaverAuth({
    db,
    secret: process.env.AUTH_SECRET!,
    baseURL: process.env.AUTH_URL ?? "http://localhost:3000",
  });
  try {
    await resetTestState(db, "e2e");

    const password = "admin1234567";
    await createCredentialUser(auth, {
      email: "admin@weaver.local",
      password,
      name: "Admin",
      role: "Admin",
    });
    for (const [email, name] of [
      ["owner@weaver.local", "Olivia Owner"],
      ["editor@weaver.local", "Emma Editor"],
      ["viewer@weaver.local", "Victor Viewer"],
      ["personal@weaver.local", "Pat Personal"],
    ] as const) {
      await createCredentialUser(auth, { email, password, name, role: "User" });
    }

    // Seed the resource/client before any application runtime starts.
    const resource = process.env.WEAVER_MCP_RESOURCE_URL!;
    const now = new Date();
    const scopes = [
      "mcp:use",
      "content:read",
      "content:propose",
      "content:write",
      "offline_access",
    ];
    await db.oauthResource.upsert({
      where: { identifier: resource },
      update: {},
      create: {
        identifier: resource,
        name: "Weaver MCP",
        allowedScopes: scopes,
        dpopBoundAccessTokensRequired: false,
        disabled: false,
        policyVersion: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.oauthClient.create({
      data: {
        clientId: "e2e-mcp-client",
        name: "E2E MCP client",
        redirectUris: ["http://127.0.0.1:4545/callback"],
        scopes,
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
        applicationType: "native",
        requirePKCE: true,
        disabled: false,
        skipConsent: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.oauthClientResource.create({
      data: {
        clientId: "e2e-mcp-client",
        resourceId: resource,
        createdAt: now,
      },
    });

    const admin = await db.user.findUniqueOrThrow({
      where: { email: "admin@weaver.local" },
    });
    const actor = createSessionSecurityContext({
      userId: admin.id,
      globalRole: "Admin",
      sessionId: "e2e-global-setup",
    });
    const ring = loadEncryptionKeyRing();
    if (!ring) throw new Error(".env.e2e needs WEAVER_ENCRYPTION_KEYS");
    const connection = await createLlmConnection(
      db,
      actor,
      { ring },
      {
        name: "E2E mock provider",
        providerType: "openai_compatible",
        endpoint: process.env.WEAVER_E2E_AI_BASE_URL!,
        credential: "e2e-key",
        requestTimeoutMs: 5000,
      },
    );
    const extraction = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "e2e-extraction",
      displayName: "E2E extraction",
      capabilities: ["chat", "json_output", "tool_use"],
      // The assistant refuses to run against a model without a context window.
      contextWindow: 128_000,
      maxOutputTokens: 4096,
    });
    const embedding = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "e2e-embedding",
      displayName: "E2E embedding",
      capabilities: ["embedding"],
      embeddingDimensions: 1536,
    });
    await setLlmRoute(db, actor, {
      purpose: "knowledge_extraction",
      modelId: extraction.id,
    });
    await setLlmRoute(db, actor, {
      purpose: "knowledge_embedding",
      modelId: embedding.id,
    });
    await setLlmRoute(db, actor, {
      purpose: "assistant",
      modelId: extraction.id,
    });
    const jobs = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "e2e-jobs",
      displayName: "E2E jobs",
      capabilities: ["chat"],
    });
    await setLlmRoute(db, actor, { purpose: "jobs", modelId: jobs.id });
  } finally {
    await db.$disconnect();
  }
}
