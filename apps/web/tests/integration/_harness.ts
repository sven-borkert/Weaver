import type { OidcProviderOptions } from "@weaver/config/oidc";
import { fileURLToPath } from "node:url";
import { assertTestEnvironment } from "@weaver/config/testEnvironment";
import { resetTestState } from "../_reset";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  type LlmModelCapability,
  type Role,
} from "@weaver/db/client";
import type { AiProvider } from "@weaver/core/ai/types";
import {
  noKnowledgeRouting,
  type KnowledgeRoutingSource,
} from "@weaver/core/ai/registry";
import { stopKnowledgePublisher } from "@weaver/core/jobs/publisher";
import {
  createLlmConnection,
  createLlmModel,
} from "@weaver/core/services/llmConnections";
import {
  invalidateLlmRouteCache,
  type KnowledgeRouting,
  resolveKnowledgeRouting,
  setLlmRoute,
} from "@weaver/core/services/llmRoutes";
import { invalidateDiagnosticsSettingsCache } from "@weaver/core/services/diagnosticsSettings";
import {
  createApiKeyIssuer,
  createCredentialUser,
  createPasswordChanger,
  createUserAdministrator,
  createWeaverAuth,
  OAUTH_SCOPES,
  type WeaverAuth,
} from "@weaver/auth";
import { toOrganizationRole } from "@weaver/core/roles";
import {
  createSessionSecurityContext,
  type UserSecurityContext,
} from "@weaver/core/security/context";
import {
  loadEncryptionKeyRing,
  type EncryptionKeyRing,
} from "@weaver/core/security/encryption";
import type { DocumentContentInput } from "@weaver/core/services/documents";
import { createCaller } from "~/server/api/root";

export { noKnowledgeRouting };

/** The TipTap tree of a document read that must be Markdown. */
export function markdownContent(document: { content: DocumentContentInput }) {
  if (document.content.kind !== "markdown")
    throw new Error(
      `expected a markdown document, got ${document.content.kind}`,
    );
  return document.content.contentJson;
}

export function fakeRoutingSource(
  routing: KnowledgeRouting,
  provider: AiProvider,
): KnowledgeRoutingSource {
  return {
    resolve: async () => routing,
    resolveFresh: async () => routing,
    providerFor: () => provider,
  };
}

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  prisma ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  return prisma;
}

export const TEST_PASSWORD = "password12345";
export const TEST_MCP_RESOURCE = "http://localhost:3000/api/mcp";
export const TEST_ISSUER = "http://localhost:3000/api/auth";

let auth: WeaverAuth | undefined;

/** Real Better Auth instance on weaver_test; mirrors apps/web/src/server/auth. */
export function testAuth(): WeaverAuth {
  auth ??= createWeaverAuth({
    db: getPrisma(),
    secret: process.env.AUTH_SECRET!,
    baseURL: "http://localhost:3000",
    mcp: {
      resource: TEST_MCP_RESOURCE,
      loginPage: "/login",
      consentPage: "/consent",
    },
    onSignIn: async (userId) => {
      await getPrisma().user.update({
        where: { id: userId },
        data: { lastLoginAt: new Date() },
      });
    },
  });
  return auth;
}

/**
 * The OAuth provider seeds its resource row once at plugin init; resetDb()
 * truncates it, so OAuth specs re-create it before authorizing.
 */
export async function ensureOAuthResource(): Promise<void> {
  const now = new Date();
  await getPrisma().oauthResource.upsert({
    where: { identifier: TEST_MCP_RESOURCE },
    update: {},
    create: {
      identifier: TEST_MCP_RESOURCE,
      name: "Weaver MCP",
      allowedScopes: [...OAUTH_SCOPES],
      dpopBoundAccessTokensRequired: false,
      disabled: false,
      policyVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
  });
}

export async function resetDb(): Promise<void> {
  assertTestEnvironment(
    process.env,
    "integration",
    fileURLToPath(new URL("../../../../", import.meta.url)),
  );
  await stopKnowledgePublisher();
  await resetTestState(getPrisma(), "integration");
  invalidateLlmRouteCache();
  invalidateDiagnosticsSettingsCache();
}

export async function makeUser(
  role: Role,
  suffix = "u",
): Promise<{ id: string; role: Role; email: string }> {
  // Lowercased to match what Better Auth stores/looks up by (createCredentialUser
  // normalizes email casing internally).
  const email = `${role.toLowerCase()}-${suffix}@test.local`.toLowerCase();
  const { id } = await createCredentialUser(testAuth(), {
    email,
    password: TEST_PASSWORD,
    name: `${role} ${suffix}`,
    role,
  });
  await getPrisma().session.create({
    data: {
      id,
      userId: id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { id, role, email };
}

export async function makeProject(
  name = "Test Project",
): Promise<{ id: string }> {
  const db = getPrisma();
  const id = randomUUID();
  return db.project.create({
    data: {
      id,
      name,
      organization: { create: { name, slug: `project-${id}` } },
    },
    select: { id: true },
  });
}

export async function addMembership(
  projectId: string,
  userId: string,
  role: "Owner" | "Maintainer" | "Editor" | "Viewer",
): Promise<void> {
  const db = getPrisma();
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { organizationId: true },
  });
  await db.member.create({
    data: {
      organizationId: project.organizationId,
      userId,
      role: toOrganizationRole(role),
    },
  });
}

/** Marks the wiki enabled for the agent without running bootstrap. */
export async function bindWikiSettings(
  projectId: string,
  agentId: string,
): Promise<void> {
  await getPrisma().projectWikiSettings.upsert({
    where: { projectId },
    create: { projectId, agentId, enabled: true, enabledAt: new Date() },
    update: { agentId, enabled: true },
  });
}

/** A queue item for specs that need a real target for wikiSourceItemId. */
export async function makeWikiInputItem(projectId: string): Promise<string> {
  const item = await getPrisma().wikiInputItem.create({
    data: { projectId, kind: "text", title: "Input", byteSize: 0 },
    select: { id: true },
  });
  return item.id;
}

export function securityContextFor(user: { id: string; role: Role }) {
  return createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.id,
  });
}

export function testEncryptionKeys(): EncryptionKeyRing {
  const ring = loadEncryptionKeyRing();
  if (!ring)
    throw new Error(
      "Add WEAVER_ENCRYPTION_KEYS to .env.test (openssl rand -base64 32)",
    );
  return ring;
}

export async function seedTestLlmRouting(
  options: {
    endpoint?: string;
    extractionModel?: string;
    embeddingModel?: string;
    pricing?: { input: number; output: number; currency: string };
    /** Declares a third model and routes `ingestion` to it. */
    ingestion?: {
      capabilities: LlmModelCapability[];
      providerModelId?: string;
    };
    /** Declares a chat-only model and routes `jobs` to it. */
    jobs?: boolean;
  } = {},
) {
  const admin = await makeUser("Admin");
  const actor = securityContextFor(admin);
  const db = getPrisma();
  const deps = { ring: testEncryptionKeys() };
  const connection = await createLlmConnection(db, actor, deps, {
    name: `Test provider ${randomUUID().slice(0, 8)}`,
    providerType: "openai_compatible",
    endpoint: options.endpoint ?? "https://ai.test/v1",
    credential: "test-key",
    requestTimeoutMs: 1000,
  });
  const extraction = await createLlmModel(db, actor, {
    connectionId: connection.id,
    providerModelId: options.extractionModel ?? "test-extraction",
    displayName: "Extraction",
    contextWindow: 128000,
    capabilities: ["chat", "json_output", "tool_use"],
    inputCostMicrosPerMillion: options.pricing?.input ?? null,
    outputCostMicrosPerMillion: options.pricing?.output ?? null,
    currency: options.pricing?.currency ?? null,
  });
  const embedding = await createLlmModel(db, actor, {
    connectionId: connection.id,
    providerModelId: options.embeddingModel ?? "test-embedding",
    displayName: "Embedding",
    capabilities: ["embedding"],
    embeddingDimensions: 1536,
    inputCostMicrosPerMillion: options.pricing?.input ?? null,
    outputCostMicrosPerMillion: options.pricing?.output ?? null,
    currency: options.pricing?.currency ?? null,
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
  if (options.ingestion) {
    const ingestion = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: options.ingestion.providerModelId ?? "test-vision",
      displayName: "Ingestion",
      capabilities: options.ingestion.capabilities,
      inputCostMicrosPerMillion: options.pricing?.input ?? null,
      outputCostMicrosPerMillion: options.pricing?.output ?? null,
      currency: options.pricing?.currency ?? null,
    });
    await setLlmRoute(db, actor, {
      purpose: "ingestion",
      modelId: ingestion.id,
    });
  }
  if (options.jobs) {
    const jobs = await createLlmModel(db, actor, {
      connectionId: connection.id,
      providerModelId: "test-jobs",
      displayName: "Jobs",
      capabilities: ["chat"],
      inputCostMicrosPerMillion: options.pricing?.input ?? null,
      outputCostMicrosPerMillion: options.pricing?.output ?? null,
      currency: options.pricing?.currency ?? null,
    });
    await setLlmRoute(db, actor, { purpose: "jobs", modelId: jobs.id });
  }
  invalidateLlmRouteCache();
  const routing = await resolveKnowledgeRouting(db);
  if (!routing)
    throw new Error("seedTestLlmRouting did not produce ready routing");
  return { admin, connection, routing };
}

export type CallerOverrides = {
  llmFetch?: typeof fetch;
  oidcFetch?: typeof fetch;
  oidcFallback?: OidcProviderOptions;
  encryptionKeys?: EncryptionKeyRing | null;
  /**
   * Request headers for the caller's context. Defaults to empty, which is
   * fine for fabricated-security-context calls — but any procedure that
   * calls back into Better Auth's own API (e.g. account.changePassword,
   * which re-resolves the session from a cookie) needs a real signed-in
   * session here (see accountPassword.spec.ts's signInHeaders helper).
   */
  headers?: Headers;
};

/** Build a tRPC caller for the user with an explicit UserSecurityContext (keys/tokens). */
export function callerWithSecurity(
  user: {
    id: string;
    role: Role;
    email: string;
    mustChangePassword?: boolean;
  },
  security: UserSecurityContext,
  overrides: CallerOverrides = {},
) {
  return createCaller({
    db: getPrisma(),
    session: {
      user: {
        id: user.id,
        role: user.role,
        email: user.email,
        name: `${user.role} test user`,
        sessionId: user.id,
        mustChangePassword: user.mustChangePassword ?? false,
      },
    },
    security,
    apiKeyIssuer: createApiKeyIssuer(testAuth()),
    userAdministrator: createUserAdministrator(testAuth()),
    passwordChanger: createPasswordChanger(testAuth()),
    encryptionKeys:
      overrides.encryptionKeys === undefined
        ? testEncryptionKeys()
        : overrides.encryptionKeys,
    llmFetch: overrides.llmFetch ?? fetch,
    oidcFetch: overrides.oidcFetch ?? fetch,
    oidcFallback: overrides.oidcFallback,
    headers: overrides.headers ?? new Headers(),
  } as never);
}

/** Build a tRPC caller authenticated as the given user's browser session. */
export function callerFor(
  user: {
    id: string;
    role: Role;
    email: string;
    mustChangePassword?: boolean;
  },
  overrides: CallerOverrides = {},
) {
  return callerWithSecurity(user, securityContextFor(user), overrides);
}
