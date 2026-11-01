import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createBearerVerifiers } from "@weaver/auth";
import * as diagnosticWriter from "@weaver/core/diagnostics/writer";
import { blobExists, openUploadSink } from "@weaver/core/ingestion/blobStore";
import { MAX_EXTERNAL_JSON_FILE_BYTES } from "@weaver/core/ingestion/limits";
import {
  FakeJobQueue,
  setJobQueueForTests,
  type JobQueue,
} from "@weaver/core/jobs/queue";
import { createSlidingWindowLimiter } from "@weaver/core/security/rateLimit";
import {
  authorizeIngestionUpload,
  finalizeUploadBatch,
} from "@weaver/core/services/ingestion";
import {
  apiKeyPermissionsFromCapabilities,
  createApiKeySecurityContext,
  type ApiKeyCapability,
} from "@weaver/core/security/context";
import {
  addMembership,
  callerFor,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  TEST_PASSWORD,
  testAuth,
} from "./_harness";
import { getBearerVerifiers } from "~/server/auth/bearer";
import { setExternalIngestionLimiterForTests } from "~/server/ingestion/externalLimiter";

vi.mock("~/server/auth/bearer", () => ({ getBearerVerifiers: vi.fn() }));

type TestUser = { id: string; role: "Admin" | "User"; email: string };
type GrantableCapability = Exclude<
  ApiKeyCapability,
  "mcp:use" | "content:read"
>;

const MARKDOWN = new TextEncoder().encode("# Feed\n\nPushed by a system.\n");
const ROUTE_URL = "http://localhost:3000/api/ingestion/external";
type ExternalRoute = (request: Request) => Promise<Response>;

function dataDir(): string {
  return process.env.WEAVER_DATA_DIR!;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function storedEntries(projectId: string): Promise<string[]> {
  const filesRoot = path.join(dataDir(), "files", projectId);
  try {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(filesRoot, { recursive: true });
    const inspected = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        info: await fs.stat(path.join(filesRoot, entry)),
      })),
    );
    return inspected
      .filter(({ info }) => info.isFile())
      .map(({ entry }) => entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function keyContext(
  user: TestUser,
  capabilities: ApiKeyCapability[],
  projectIds: string[] = [],
) {
  return createApiKeySecurityContext({
    userId: user.id,
    globalRole: user.role,
    keyId: randomUUID(),
    permissions: apiKeyPermissionsFromCapabilities(capabilities),
    projectIds,
  });
}

async function projectWithEditor(suffix: string) {
  const user = await makeUser("User", `feed-${suffix}`);
  const project = await makeProject(`Feed ${suffix}`);
  await addMembership(project.id, user.id, "Editor");
  return { user, project };
}

async function stageUpload(projectId: string, bytes: Uint8Array) {
  const uploadId = randomUUID();
  const sink = await openUploadSink(dataDir(), projectId, uploadId);
  await sink.write(bytes);
  const stored = await sink.finish();
  return { uploadId, byteSize: stored.byteSize, contentDigest: stored.digest };
}

let externalRoute: ExternalRoute;

async function mintKey(
  user: TestUser,
  capabilities: GrantableCapability[] = ["ingest:external"],
  projectIds: string[] = [],
): Promise<{ id: string; secret: string }> {
  const created = await callerFor(user).apiKey.create({
    name: `Feed ${randomUUID().slice(0, 8)}`,
    capabilities,
    projectIds,
  });
  return { id: created.key.id, secret: created.secret };
}

async function editorWithKey(
  suffix: string,
  capabilities: GrantableCapability[] = ["ingest:external"],
) {
  const { user, project } = await projectWithEditor(suffix);
  const key = await mintKey(user, capabilities);
  return { user, project, key };
}

function feedForm(projectId: string, file: File, label?: string): FormData {
  const form = new FormData();
  form.set("projectId", projectId);
  if (label !== undefined) form.set("label", label);
  form.append("file", file);
  return form;
}

function multipartRequest(secret: string | null, form: FormData): Request {
  return new Request(ROUTE_URL, {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    body: form,
  });
}

function jsonRequest(
  secret: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(ROUTE_URL, {
    method: "POST",
    headers: {
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function markdownFile(name = "feed.md"): File {
  return new File([MARKDOWN], name, { type: "text/markdown" });
}

async function sessionCookieFor(email: string): Promise<string> {
  const response = await testAuth().api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    asResponse: true,
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  expect(cookie).toMatch(/session_token=/);
  return cookie!;
}

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  vi.mocked(getBearerVerifiers).mockImplementation(() =>
    createBearerVerifiers(testAuth(), {
      issuer: TEST_ISSUER,
      audience: TEST_MCP_RESOURCE,
    }),
  );
  const route = await import("~/app/api/ingestion/external/route");
  externalRoute = route.POST as unknown as ExternalRoute;
});

afterAll(() => vi.unstubAllEnvs());

describe("external submission authorization", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("accepts an external batch from a key holding ingest:external but not content:write", async () => {
    const db = getPrisma();
    const { user, project } = await projectWithEditor("service-ok");
    const staged = await stageUpload(project.id, MARKDOWN);

    const result = await finalizeUploadBatch(
      db,
      keyContext(user, ["ingest:external"]),
      {
        projectId: project.id,
        origin: "external",
        label: "nightly",
        files: [{ ...staged, fileName: "feed.md", mimeType: "text/markdown" }],
      },
      { dataDir: dataDir() },
    );

    const batch = await db.ingestionBatch.findUniqueOrThrow({
      where: { id: result.batchId },
    });
    expect(batch).toMatchObject({
      origin: "external",
      createdById: user.id,
      label: "nightly",
      projectId: project.id,
    });
    expect(result.files[0]).toMatchObject({
      fileName: "feed.md",
      status: "pending",
      contentDigest: sha256(MARKDOWN),
    });
    expect(await blobExists(dataDir(), project.id, sha256(MARKDOWN))).toBe(
      true,
    );
  });

  it("keeps the channel capability and the content capability apart", async () => {
    const db = getPrisma();
    const { user, project } = await projectWithEditor("service-caps");

    await expect(
      authorizeIngestionUpload(
        db,
        keyContext(user, ["content:write"]),
        project.id,
        "external",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      authorizeIngestionUpload(
        db,
        keyContext(user, ["ingest:external"]),
        project.id,
        "upload",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      authorizeIngestionUpload(
        db,
        keyContext(user, ["ingest:external"]),
        project.id,
        "external",
      ),
    ).resolves.toEqual({ projectId: project.id });

    const staged = await stageUpload(project.id, MARKDOWN);
    await expect(
      finalizeUploadBatch(
        db,
        keyContext(user, ["content:write"]),
        {
          projectId: project.id,
          origin: "external",
          files: [
            { ...staged, fileName: "feed.md", mimeType: "text/markdown" },
          ],
        },
        { dataDir: dataDir() },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.ingestionBatch.count()).toBe(0);
  });

  it("still requires Editor membership inside the key's project restriction", async () => {
    const db = getPrisma();
    const { user, project } = await projectWithEditor("service-membership");
    const viewer = await makeUser("User", "feed-viewer");
    await addMembership(project.id, viewer.id, "Viewer");
    const outsider = await makeUser("User", "feed-outsider");
    const other = await makeProject("Feed other");

    await expect(
      authorizeIngestionUpload(
        db,
        keyContext(viewer, ["ingest:external"]),
        project.id,
        "external",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      authorizeIngestionUpload(
        db,
        keyContext(outsider, ["ingest:external"]),
        project.id,
        "external",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      authorizeIngestionUpload(
        db,
        keyContext(user, ["ingest:external"], [other.id]),
        project.id,
        "external",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("external feed route", () => {
  let queue: FakeJobQueue;

  beforeEach(async () => {
    await resetDb();
    queue = new FakeJobQueue();
    setJobQueueForTests(queue);
  });

  afterEach(() => {
    setJobQueueForTests(null);
    setExternalIngestionLimiterForTests(null);
    vi.stubEnv("WEAVER_JOBS_ENABLED", "true");
  });

  it("accepts multipart and JSON submissions as external batches", async () => {
    const db = getPrisma();
    const multipart = await editorWithKey("multipart");
    const diagnostic = vi.spyOn(diagnosticWriter, "emitDiagnostic");
    const multipartResponse = await externalRoute(
      multipartRequest(
        multipart.key.secret,
        feedForm(multipart.project.id, markdownFile(), "nightly export"),
      ),
    );
    expect(multipartResponse.status).toBe(201);
    const multipartBody = (await multipartResponse.json()) as {
      batchId: string;
      file: { id: string; fileName: string; status: string };
    };
    expect(multipartBody.file).toEqual({
      id: expect.any(String),
      fileName: "feed.md",
      status: "pending",
    });
    const multipartBatch = await db.ingestionBatch.findUniqueOrThrow({
      where: { id: multipartBody.batchId },
      include: { files: true },
    });
    expect(multipartBatch).toMatchObject({
      origin: "external",
      createdById: multipart.user.id,
      label: "nightly export",
      projectId: multipart.project.id,
    });
    expect(multipartBatch.files[0]).toMatchObject({
      id: multipartBody.file.id,
      mimeType: "text/markdown",
      byteSize: MARKDOWN.byteLength,
      contentDigest: sha256(MARKDOWN),
      status: "pending",
    });
    expect(
      await blobExists(dataDir(), multipart.project.id, sha256(MARKDOWN)),
    ).toBe(true);
    expect(queue.jobs).toEqual([
      {
        name: "ingestion.parse",
        data: {
          fileId: multipartBody.file.id,
          projectId: multipart.project.id,
          contentDigest: sha256(MARKDOWN),
          baseAttemptCount: 0,
        },
      },
    ]);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingestion.external.submitted",
        outcome: "ok",
        statusCode: 201,
        userId: multipart.user.id,
        credentialId: multipart.key.id,
        projectId: multipart.project.id,
        details: expect.objectContaining({
          batchId: multipartBody.batchId,
          fileId: multipartBody.file.id,
          form: "multipart/form-data",
        }),
      }),
    );
    diagnostic.mockRestore();
    const listed = await callerFor(multipart.user).ingestion.listBatches({
      projectId: multipart.project.id,
    });
    expect(listed.items[0]).toMatchObject({
      id: multipartBody.batchId,
      origin: "external",
    });

    const json = await editorWithKey("json");
    const jsonResponse = await externalRoute(
      jsonRequest(json.key.secret, {
        projectId: json.project.id,
        fileName: "notes.md",
        contentType: "text/markdown; charset=utf-8",
        content: Buffer.from(MARKDOWN).toString("base64"),
      }),
    );
    expect(jsonResponse.status).toBe(201);
    const jsonBody = (await jsonResponse.json()) as {
      file: { id: string; fileName: string };
    };
    expect(jsonBody.file.fileName).toBe("notes.md");
    expect(
      await db.ingestionFile.findUniqueOrThrow({
        where: { id: jsonBody.file.id },
      }),
    ).toMatchObject({
      mimeType: "text/markdown",
      byteSize: MARKDOWN.byteLength,
      contentDigest: sha256(MARKDOWN),
    });
    expect(await blobExists(dataDir(), json.project.id, sha256(MARKDOWN))).toBe(
      true,
    );
    expect(queue.jobs).toHaveLength(2);
  });

  it("requires a live personal key with ingest:external", async () => {
    const db = getPrisma();
    const { user, project, key } = await editorWithKey("credentials");
    const cookie = await sessionCookieFor(user.email);
    await callerFor(user).apiKey.revoke({ keyId: key.id });
    const sessionOnly = multipartRequest(
      null,
      feedForm(project.id, markdownFile()),
    );
    sessionOnly.headers.set("cookie", cookie);
    for (const request of [
      multipartRequest(null, feedForm(project.id, markdownFile())),
      sessionOnly,
      multipartRequest(
        "eyJhbGciOiJFZERTQSJ9.e30.c2ln",
        feedForm(project.id, markdownFile()),
      ),
      multipartRequest(key.secret, feedForm(project.id, markdownFile())),
    ]) {
      expect((await externalRoute(request)).status).toBe(401);
    }
    const writeOnly = await editorWithKey("write-only", ["content:write"]);
    const diagnostic = vi.spyOn(diagnosticWriter, "emitDiagnostic");
    const denied = await externalRoute(
      multipartRequest(
        writeOnly.key.secret,
        feedForm(writeOnly.project.id, markdownFile()),
      ),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "the ingest:external capability is required",
    });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingestion.external.submitted",
        outcome: "denied",
        statusCode: 403,
      }),
    );
    diagnostic.mockRestore();
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await storedEntries(project.id)).toEqual([]);
    expect(queue.jobs).toEqual([]);
  });

  it.each([
    ["Viewer", 403],
    ["non-member", 404],
    ["restricted to another project", 404],
  ] as const)("enforces membership: %s → %i", async (kind, status) => {
    const db = getPrisma();
    const { project } = await projectWithEditor(`membership-${kind}`);
    const other = await makeProject(`Feed other ${kind}`);
    const submitter = await makeUser("User", `feed-${kind}`);
    let secret: string;
    if (kind === "Viewer") {
      await addMembership(project.id, submitter.id, "Viewer");
      ({ secret } = await mintKey(submitter));
    } else if (kind === "non-member") {
      ({ secret } = await mintKey(submitter));
    } else {
      await addMembership(project.id, submitter.id, "Editor");
      await addMembership(other.id, submitter.id, "Editor");
      ({ secret } = await mintKey(submitter, ["ingest:external"], [other.id]));
    }
    expect(
      (
        await externalRoute(
          multipartRequest(secret, feedForm(project.id, markdownFile())),
        )
      ).status,
    ).toBe(status);
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await storedEntries(project.id)).toEqual([]);
  });

  it("authorizes JSON projects before validating file fields", async () => {
    const { project } = await projectWithEditor("json-auth-order");
    const outsider = await makeUser("User", "json-auth-order-outsider");
    const key = await mintKey(outsider);
    const response = await externalRoute(
      jsonRequest(key.secret, {
        projectId: project.id,
        fileName: "",
        contentType: "invalid",
        content: "not base64",
      }),
    );
    expect(response.status).toBe(404);
  });

  it("rejects unsupported, malformed, and oversized JSON without storing", async () => {
    const db = getPrisma();
    const { project, key } = await editorWithKey("validation");
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(
      (
        await externalRoute(
          jsonRequest(key.secret, {
            projectId: project.id,
            fileName: "tool.exe",
            contentType: "application/x-msdownload",
            content: "TVo=",
          }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await externalRoute(
          jsonRequest(key.secret, {
            projectId: project.id,
            fileName: "fake.pdf",
            contentType: "application/pdf",
            content: Buffer.from(png).toString("base64"),
          }),
        )
      ).status,
    ).toBe(415);
    expect((await externalRoute(jsonRequest(key.secret, "{"))).status).toBe(
      400,
    );
    expect(
      (
        await externalRoute(
          jsonRequest(key.secret, {
            projectId: project.id,
            fileName: "notes.md",
            contentType: "text/markdown",
            content: "not*base64*",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await externalRoute(
          jsonRequest(key.secret, { projectId: project.id, fileName: "x.md" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await externalRoute(
          new Request(ROUTE_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${key.secret}`,
              "content-type": "text/plain",
            },
            body: "hello",
          }),
        )
      ).status,
    ).toBe(415);
    const twoFiles = feedForm(project.id, markdownFile("one.md"));
    twoFiles.append("file", markdownFile("two.md"));
    const tooMany = await externalRoute(multipartRequest(key.secret, twoFiles));
    expect(tooMany.status).toBe(413);
    expect(await tooMany.json()).toEqual({
      error: "no more than 1 file is allowed",
    });
    const oversized = Buffer.alloc(MAX_EXTERNAL_JSON_FILE_BYTES + 1, 0x61);
    expect(
      (
        await externalRoute(
          jsonRequest(key.secret, {
            projectId: project.id,
            fileName: "big.txt",
            contentType: "text/plain",
            content: oversized.toString("base64"),
          }),
        )
      ).status,
    ).toBe(413);
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await storedEntries(project.id)).toEqual([]);
    expect(queue.jobs).toEqual([]);
  });

  it("bounds the JSON form by declared and actual size", async () => {
    const db = getPrisma();
    const { project, key } = await editorWithKey("json-bounds");
    const declared = await externalRoute(
      jsonRequest(key.secret, "{}", { "content-length": "99999999999" }),
    );
    expect(declared.status).toBe(413);
    const oversized = Buffer.alloc(MAX_EXTERNAL_JSON_FILE_BYTES + 1, 0x61);
    expect(
      (
        await externalRoute(
          jsonRequest(key.secret, {
            projectId: project.id,
            fileName: "big.txt",
            contentType: "text/plain",
            content: oversized.toString("base64"),
          }),
        )
      ).status,
    ).toBe(413);
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await storedEntries(project.id)).toEqual([]);
  });

  it("sets Retry-After for route and verifier rate limits", async () => {
    const { project, key } = await editorWithKey("rate-limit");
    const second = await editorWithKey("rate-limit-other");
    await addMembership(project.id, second.user.id, "Editor");
    setExternalIngestionLimiterForTests(
      createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 }),
    );
    expect(
      (
        await externalRoute(
          multipartRequest(key.secret, feedForm(project.id, markdownFile())),
        )
      ).status,
    ).toBe(201);
    const limited = await externalRoute(
      multipartRequest(key.secret, feedForm(project.id, markdownFile())),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toEqual({ error: "rate limit exceeded" });
    expect(
      (
        await externalRoute(
          multipartRequest(
            second.key.secret,
            feedForm(project.id, markdownFile("other.md")),
          ),
        )
      ).status,
    ).toBe(201);
    const realVerifiers = createBearerVerifiers(testAuth(), {
      issuer: TEST_ISSUER,
      audience: TEST_MCP_RESOURCE,
    });
    vi.mocked(getBearerVerifiers).mockReturnValueOnce({
      ...realVerifiers,
      verifyApiKey: async () => ({ ok: false, reason: "rate_limited" }),
    });
    const verifierLimited = await externalRoute(
      multipartRequest(key.secret, feedForm(project.id, markdownFile())),
    );
    expect(verifierLimited.status).toBe(429);
    expect(verifierLimited.headers.get("retry-after")).toBe("60");
  });

  it("checks jobs after authentication and does not write while disabled", async () => {
    const db = getPrisma();
    const { project, key } = await editorWithKey("jobs-disabled");
    vi.stubEnv("WEAVER_JOBS_ENABLED", "false");
    expect(
      (
        await externalRoute(
          multipartRequest(null, feedForm(project.id, markdownFile())),
        )
      ).status,
    ).toBe(401);
    const response = await externalRoute(
      multipartRequest(key.secret, feedForm(project.id, markdownFile())),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "jobs are disabled" });
    expect(await db.ingestionBatch.count()).toBe(0);
    expect(await storedEntries(project.id)).toEqual([]);
  });

  it("returns durable identity when parse publication fails", async () => {
    const db = getPrisma();
    const { project, key } = await editorWithKey("queue-failure");
    const diagnostic = vi.spyOn(diagnosticWriter, "emitDiagnostic");
    const failingQueue: JobQueue = {
      send: async () => {
        throw new Error("queue unavailable");
      },
      work: async () => undefined,
      schedule: async () => undefined,
      stop: async () => undefined,
    };
    setJobQueueForTests(failingQueue);
    const response = await externalRoute(
      multipartRequest(key.secret, feedForm(project.id, markdownFile())),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      batchId: string;
      file: { status: string };
    };
    expect(body).toMatchObject({
      error: "file stored but parse job publication failed",
      batchId: expect.any(String),
      file: { fileName: "feed.md", status: "pending" },
    });
    expect(
      await db.ingestionFile.count({ where: { batchId: body.batchId } }),
    ).toBe(1);
    expect(await blobExists(dataDir(), project.id, sha256(MARKDOWN))).toBe(
      true,
    );
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingestion.external.submitted",
        outcome: "error",
        statusCode: 503,
      }),
    );
    diagnostic.mockRestore();
  });
});

it("bounds unverified token rotation by source before credential verification", async () => {
  const statuses: number[] = [];
  for (let index = 0; index < 121; index++) {
    const response = await externalRoute(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: { authorization: `Bearer wvr_invalid_${index}` },
      }),
    );
    statuses.push(response.status);
  }
  expect(statuses).toContain(429);
});
