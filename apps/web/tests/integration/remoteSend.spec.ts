import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleGit } from "simple-git";
import { createBearerVerifiers } from "@weaver/auth";
import { repoDir, withProjectRepo } from "@weaver/git-store";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import type { CoreError } from "@weaver/core/errors";
import {
  createDocument,
  getDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import { storeDocumentImage } from "@weaver/core/services/documentImages";
import { createTable, getTable } from "@weaver/core/services/tables";
import {
  beginRemoteConnection,
  buildDocumentTransferPayload,
  buildTableTransferPayload,
  createRemoteInstance,
  fetchTransferTargetFolders,
  fetchTransferTargets,
  sendDocumentToRemote,
  sendTableToRemote,
  syncRemoteOauthClient,
} from "@weaver/core/services/remoteInstances";
import type { RemoteRuntimeDeps } from "@weaver/core/services/remoteInstances/types";
import { handleRemoteCallback } from "~/app/api/remotes/callback/route";
import { getSessionUser, type SessionUser } from "~/server/auth";
import { getBearerVerifiers } from "~/server/auth/bearer";
import {
  addMembership,
  ensureOAuthResource,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  testAuth,
  testEncryptionKeys,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  TEST_PASSWORD,
  markdownContent,
} from "./_harness";
import { redirectTargetOf, sessionCookieFor } from "./_oauth";
import { testRemoteFetch } from "./_remoteFetch";

vi.mock("~/server/auth/bearer", () => ({ getBearerVerifiers: vi.fn() }));

const B = "http://localhost:3000"; // the test instance plays the remote
const A = "http://localhost:3000/a"; // this instance's own identity, distinct from B
const ONE_PIXEL_PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
  156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0,
  73, 69, 78, 68, 174, 66, 96, 130,
]);

const deps = (): RemoteRuntimeDeps => ({
  db: getPrisma(),
  ring: testEncryptionKeys(),
  fetchImpl: testRemoteFetch(),
  now: () => new Date(),
  selfBaseUrl: A,
  mcpResourceUrl: TEST_MCP_RESOURCE,
  allowedOrigins: [],
  pinOutbound: false,
});

async function resolveTestSession(
  headers: Headers,
): Promise<SessionUser | null> {
  const session = await testAuth().api.getSession({ headers });
  if (!session || session.user.banned) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role === "Admin" ? "Admin" : "User",
    sessionId: session.session.id,
    mustChangePassword: session.user.mustChangePassword === true,
  };
}

/** Drives B's authorize + consent with the user's cookie and returns the callback URL B redirects to. */
async function authorizeOnRemote(
  authorizeUrl: string,
  cookie: string,
): Promise<URL> {
  const first = await testAuth().handler(
    new Request(authorizeUrl, { headers: { cookie } }),
  );
  const target = await redirectTargetOf(first);
  if (target.includes("/consent")) {
    const consent = await testAuth().handler(
      new Request(`${B}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: B },
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(target, B).search.slice(1),
        }),
      }),
    );
    return new URL(await redirectTargetOf(consent), B);
  }
  return new URL(target, B);
}

async function connected(suffix: string) {
  const db = getPrisma();
  const admin = securityContextFor(
    await makeUser("Admin", `send-${suffix}-admin`),
  );
  const user = await makeUser("User", `send-${suffix}-user`);
  const source = await makeProject(`Send ${suffix} source`);
  const target = await makeProject(`Send ${suffix} target`);
  const viewerOnly = await makeProject(`Send ${suffix} viewer`);
  await addMembership(source.id, user.id, "Editor");
  await addMembership(target.id, user.id, "Editor");
  await addMembership(viewerOnly.id, user.id, "Viewer");
  const remote = await createRemoteInstance(deps(), admin, {
    name: "B",
    baseUrl: B,
  });
  await db.$transaction((tx) =>
    syncRemoteOauthClient(
      tx,
      { name: "A", baseUrl: A, enabled: true },
      TEST_MCP_RESOURCE,
    ),
  );
  const cookie = await sessionCookieFor(user.email, TEST_PASSWORD);
  const { authorizeUrl } = await beginRemoteConnection(
    deps(),
    securityContextFor(user),
    { remoteInstanceId: remote.id },
  );
  await handleRemoteCallback(
    new Request(await authorizeOnRemote(authorizeUrl, cookie), {
      headers: { cookie },
    }),
    deps(),
  );
  const actor = {
    ...securityContextFor(user),
    name: "Sender",
    email: user.email,
  };
  return { db, user, actor, source, target, viewerOnly, remote };
}

describe("sending to a remote instance", () => {
  beforeEach(async () => {
    await resetDb();
    await ensureOAuthResource();
    vi.mocked(getSessionUser).mockImplementation(resolveTestSession);
    vi.mocked(getBearerVerifiers).mockImplementation(() =>
      createBearerVerifiers(testAuth(), {
        issuer: TEST_ISSUER,
        audience: TEST_MCP_RESOURCE,
      }),
    );
  });
  afterEach(() =>
    vi.mocked(getSessionUser).mockImplementation(() => Promise.resolve(null)),
  );

  it("old_peer_rejected_before_content_post", async () => {
    const { db, actor, source, target, remote } = await connected("old-peer");
    const { setContentAppearance } =
      await import("@weaver/core/services/contentAppearance");
    const doc = await createDocument(
      db,
      {
        projectId: source.id,
        folderPath: [],
        title: "Image",
        content: { kind: "markdown", contentJson: parseDocumentBody("x") },
      },
      actor,
    );
    await setContentAppearance(
      db,
      {
        target: { projectId: source.id, kind: "document", id: doc.id },
        expectedRevision: doc.headCommitSha,
        patch: {},
      },
      actor,
      { bytes: ONE_PIXEL_PNG },
    );
    const runtime = deps();
    const original = runtime.fetchImpl;
    const posts: string[] = [];
    runtime.fetchImpl = async (url, init) => {
      const targetUrl = url instanceof Request ? url.url : url.toString();
      if (targetUrl.endsWith("/transfer/whoami"))
        return Response.json({ userId: actor.userId });
      if (init?.method === "POST" && targetUrl.includes("/transfer/"))
        posts.push(targetUrl);
      return original(url, init);
    };
    await expect(
      sendDocumentToRemote(runtime, actor, {
        projectId: source.id,
        documentId: doc.id,
        remoteInstanceId: remote.id,
        targetProjectId: target.id,
        targetFolderPath: [],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(posts).toEqual([]);
    expect(await db.document.count({ where: { projectId: target.id } })).toBe(
      0,
    );
  });

  it("lists targets and sends a document with its image and flattened references", async () => {
    const { db, user, actor, source, target, remote } = await connected("doc");
    const other = await createDocument(
      db,
      {
        projectId: source.id,
        folderPath: [],
        title: "Referenced",
        content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
      },
      actor,
    );
    const doc = await createDocument(
      db,
      {
        projectId: source.id,
        folderPath: [],
        title: "Plan",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Draft.\n"),
        },
      },
      actor,
    );
    const stored = await storeDocumentImage(
      db,
      {
        projectId: source.id,
        documentId: doc.id,
        fileName: "chart.png",
        bytes: ONE_PIXEL_PNG,
      },
      actor,
    );
    const read = await getDocument(
      db,
      { projectId: source.id, documentId: doc.id },
      actor,
    );
    await saveDocument(
      db,
      {
        projectId: source.id,
        documentId: doc.id,
        baseCommitSha: read.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(
            `See [Referenced](weaver://document/${other.id}).\n\n![Chart](${stored.src})\n`,
          ),
        },
        changeSummary: "",
      },
      actor,
    );

    const targets = await fetchTransferTargets(deps(), actor, {
      remoteInstanceId: remote.id,
    });
    expect(targets.projects.map((p) => p.id).sort()).toEqual(
      [source.id, target.id].sort(),
    );
    const folders = await fetchTransferTargetFolders(deps(), actor, {
      remoteInstanceId: remote.id,
      projectId: target.id,
    });
    expect(folders.documents.folders).toEqual([]);

    const sent = await sendDocumentToRemote(deps(), actor, {
      remoteInstanceId: remote.id,
      projectId: source.id,
      documentId: doc.id,
      targetProjectId: target.id,
      targetFolderPath: [],
    });
    expect(sent.url).toBe(`${B}/projects/${target.id}/documents/${sent.id}`);
    const copy = await getDocument(
      db,
      { projectId: target.id, documentId: sent.id },
      actor,
    );
    expect(copy.title).toBe("Plan");
    expect(JSON.stringify(markdownContent(copy))).toContain(
      "plan.assets/chart.png",
    );
    expect(JSON.stringify(markdownContent(copy))).not.toContain("crossref");
    expect(JSON.stringify(markdownContent(copy))).toContain("Referenced");
    expect(copy.createdBy).toEqual({ id: user.id, name: expect.any(String) });
    const log = await simpleGit(repoDir(target.id)).raw([
      "log",
      "-1",
      "--format=%B",
    ]);
    expect(log).toContain(`Weaver-Operation-Id: remote-transfer:${A}`);
    expect(
      await simpleGit(repoDir(target.id)).raw([
        "show",
        "HEAD:plan.assets/chart.png",
      ]),
    ).toBeTruthy();
  });

  it("builds the payload with only the document's own images", async () => {
    const db = getPrisma();
    const user = await makeUser("User", "send-assets-user");
    const source = await makeProject("Send assets source");
    await addMembership(source.id, user.id, "Editor");
    const actor = {
      ...securityContextFor(user),
      name: "Sender",
      email: user.email,
    };
    const create = (title: string) =>
      createDocument(
        db,
        {
          projectId: source.id,
          folderPath: [],
          title,
          content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
        },
        actor,
      );
    const store = (documentId: string, fileName: string) =>
      storeDocumentImage(
        db,
        { projectId: source.id, documentId, fileName, bytes: ONE_PIXEL_PNG },
        actor,
      );
    const other = await create("Other");
    const foreign = await store(other.id, "foreign.png");
    const doc = await create("Own");
    const own = await store(doc.id, "own.png");
    const read = await getDocument(
      db,
      { projectId: source.id, documentId: doc.id },
      actor,
    );
    await saveDocument(
      db,
      {
        projectId: source.id,
        documentId: doc.id,
        baseCommitSha: read.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(
            `![Own](${own.src})\n\n![Foreign](${foreign.src})\n`,
          ),
        },
        changeSummary: "",
      },
      actor,
    );
    const payload = await buildDocumentTransferPayload(db, actor, {
      projectId: source.id,
      documentId: doc.id,
    });
    expect(payload.assetsSlug).toBe("own");
    expect(payload.images).toEqual([
      {
        name: "own.png",
        contentType: "image/png",
        bytes: ONE_PIXEL_PNG.toString("base64"),
      },
    ]);
  });

  it("leaves out images whose names B refuses and keeps their links", async () => {
    const { db, actor, source, target, remote } = await connected("names");
    const doc = await createDocument(
      db,
      {
        projectId: source.id,
        folderPath: [],
        title: "Plan",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("Draft.\n"),
        },
      },
      actor,
    );
    const stored = await storeDocumentImage(
      db,
      {
        projectId: source.id,
        documentId: doc.id,
        fileName: "chart.png",
        bytes: ONE_PIXEL_PNG,
      },
      actor,
    );
    // Git pull can bring asset names Weaver itself never allocates.
    await withProjectRepo(source.id, async (repo) => {
      await repo.writeBinaryFileAtomic(
        "plan.assets/Bad_Name.PNG",
        ONE_PIXEL_PNG,
      );
      await repo.writeBinaryFileAtomic("plan.assets/sub/x.png", ONE_PIXEL_PNG);
      await repo.commitAll("asset: pulled images (for plan.md)", {
        name: actor.name,
        email: actor.email,
        userId: actor.userId,
      });
    });
    const read = await getDocument(
      db,
      { projectId: source.id, documentId: doc.id },
      actor,
    );
    await saveDocument(
      db,
      {
        projectId: source.id,
        documentId: doc.id,
        baseCommitSha: read.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(
            `![Chart](${stored.src})\n\n![Odd](plan.assets/Bad_Name.PNG)\n\n![Nested](plan.assets/sub/x.png)\n`,
          ),
        },
        changeSummary: "",
      },
      actor,
    );
    const payload = await buildDocumentTransferPayload(db, actor, {
      projectId: source.id,
      documentId: doc.id,
    });
    expect(payload.images.map((image) => image.name)).toEqual(["chart.png"]);

    const sent = await sendDocumentToRemote(deps(), actor, {
      remoteInstanceId: remote.id,
      projectId: source.id,
      documentId: doc.id,
      targetProjectId: target.id,
      targetFolderPath: [],
    });
    const copy = await getDocument(
      db,
      { projectId: target.id, documentId: sent.id },
      actor,
    );
    const content = JSON.stringify(markdownContent(copy));
    expect(content).toContain("plan.assets/chart.png");
    expect(content).toContain("plan.assets/Bad_Name.PNG");
    expect(content).toContain("plan.assets/sub/x.png");
    const committed = await simpleGit(repoDir(target.id)).raw([
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "plan.assets",
    ]);
    expect(committed.trim().split("\n")).toEqual(["plan.assets/chart.png"]);
  });

  it("sends a table with its rows", async () => {
    const { db, actor, source, target, remote } = await connected("table");
    const { imageIconFromBytes } =
      await import("@weaver/core/services/appearanceAssets");
    const icon = imageIconFromBytes(ONE_PIXEL_PNG);
    const appearance = { backgroundColor: "#123456", icon };
    const columnId = "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c";
    const table = await createTable(
      db,
      {
        projectId: source.id,
        folderPath: [],
        title: "Inventory",
        appearance,
        iconAssets: [{ ...icon, bytes: ONE_PIXEL_PNG }],
        columns: [{ id: columnId, name: "Item", type: "text" }],
        rows: [
          {
            id: "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b",
            cells: { [columnId]: "Widget" },
          },
        ],
      },
      actor,
    );
    const sent = await sendTableToRemote(deps(), actor, {
      remoteInstanceId: remote.id,
      projectId: source.id,
      tableId: table.id,
      targetProjectId: target.id,
      targetFolderPath: [],
    });
    const copy = await getTable(
      db,
      { projectId: target.id, tableId: sent.id },
      actor,
    );
    expect(copy.appearance).toEqual(appearance);
    const files = await simpleGit(repoDir(target.id)).raw([
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
    ]);
    expect(
      files.split("\n").filter((path) => path.startsWith(`${copy.path}/`)),
    ).toEqual([`${copy.path}/data.jsonl`, `${copy.path}/schema.json`]);
    expect(files).toContain(`.weaver-icons/${icon.digest}.${icon.extension}`);
    expect(copy.rows).toEqual([
      {
        id: "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b",
        cells: { [columnId]: "Widget" },
      },
    ]);
  });

  it("sends a repaired table icon without advancing the table revision", async () => {
    const { db, actor, source, target, remote } =
      await connected("table-repair");
    const { imageIconFromBytes, readAppearanceAsset } =
      await import("@weaver/core/services/appearanceAssets");
    const { setContentAppearance } =
      await import("@weaver/core/services/contentAppearance");
    const { parseSchemaFile, serializeSchemaFile } =
      await import("@weaver/core/tables/jsonl");
    const icon = imageIconFromBytes(ONE_PIXEL_PNG);
    const table = await createTable(
      db,
      {
        projectId: source.id,
        folderPath: [],
        title: "Repaired",
        columns: [
          {
            id: "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c",
            name: "Item",
            type: "text",
          },
        ],
        rows: [],
      },
      actor,
    );
    await withProjectRepo(source.id, async (repo) => {
      const path = `${table.path}/schema.json`;
      const schema = parseSchemaFile(await repo.readFileFromWorktree(path));
      await repo.writeFileAtomic(
        path,
        serializeSchemaFile({ ...schema, appearance: { icon } }),
      );
      await repo.commitAll("test: missing table icon", actor);
    });
    const before = await getTable(
      db,
      { projectId: source.id, tableId: table.id },
      actor,
    );
    expect(
      await readAppearanceAsset(db, { projectId: source.id, icon }, actor),
    ).toBeNull();
    const repaired = await setContentAppearance(
      db,
      {
        target: { projectId: source.id, kind: "table", id: table.id },
        expectedRevision: before.baseCommitSha,
        patch: {},
      },
      actor,
      { bytes: ONE_PIXEL_PNG },
    );
    expect(repaired.headCommitSha).not.toBe(before.baseCommitSha);
    expect(repaired.revision).toBe(before.baseCommitSha);
    const after = await getTable(
      db,
      { projectId: source.id, tableId: table.id },
      actor,
    );
    expect(after.baseCommitSha).toBe(before.baseCommitSha);
    const payload = await buildTableTransferPayload(db, actor, {
      projectId: source.id,
      tableId: table.id,
    });
    expect(payload.appearance).toEqual({ icon });
    expect(after.snapshotCommitSha).toBe(repaired.headCommitSha);
    expect(payload.iconAssets).toEqual([
      {
        digest: icon.digest,
        extension: "png",
        bytes: ONE_PIXEL_PNG.toString("base64"),
      },
    ]);
    const sent = await sendTableToRemote(deps(), actor, {
      remoteInstanceId: remote.id,
      projectId: source.id,
      tableId: table.id,
      targetProjectId: target.id,
      targetFolderPath: [],
    });
    expect(
      (await getTable(db, { projectId: target.id, tableId: sent.id }, actor))
        .appearance,
    ).toEqual({ icon });
    const served = await readAppearanceAsset(
      db,
      { projectId: target.id, icon },
      actor,
    );
    expect(served && "bytes" in served ? served.bytes : null).toEqual(
      ONE_PIXEL_PNG,
    );
  });

  it("maps the remote's answers to the errors users can act on", async () => {
    const { db, actor, source, target, remote } = await connected("mapping");
    const doc = await createDocument(
      db,
      {
        projectId: source.id,
        folderPath: [],
        title: "P",
        content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
      },
      actor,
    );
    // B answers every transfer call with `answer`; OAuth still reaches the test instance.
    const stubbed = (answer: () => Response): RemoteRuntimeDeps => ({
      ...deps(),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.startsWith("/api/auth/"))
          return testAuth().handler(request);
        return answer();
      }) as typeof fetch,
    });
    const sendWith = (runtime: RemoteRuntimeDeps) =>
      sendDocumentToRemote(runtime, actor, {
        remoteInstanceId: remote.id,
        projectId: source.id,
        documentId: doc.id,
        targetProjectId: target.id,
        targetFolderPath: [],
      });
    const send = (answer: () => Response) => sendWith(stubbed(answer));
    const rejection = (pending: Promise<unknown>) =>
      pending.then(
        () => {
          throw new Error("expected the send to fail");
        },
        (error: unknown) => error as CoreError,
      );
    const failure = (answer: () => Response) => rejection(send(answer));
    const json = (status: number, body: unknown) => () =>
      Response.json(body, { status });

    const reconnect = await failure(json(401, { error: "unauthorized" }));
    expect(reconnect).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Reconnect to B",
    });
    expect(reconnect.details?.field).toBe("remoteInstanceId");
    expect(await failure(json(404, { error: "not found" }))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await failure(json(400, { error: "bad slug" }))).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("bad slug"),
    });
    expect(await failure(json(413, { error: "too big" }))).toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await failure(json(409, { error: "taken" }))).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("taken"),
    });
    expect(await failure(json(429, { error: "slow down" }))).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringContaining("slow down"),
    });
    const refused = await failure(json(412, { error: "not ready" }));
    expect(refused).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("not ready"),
    });
    expect(refused.details?.field).toBeUndefined();
    const upstream = await failure(json(502, { error: "upstream" }));
    expect(upstream).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "B answered with an error (502).",
    });
    expect(upstream.details?.field).toBeUndefined();
    const unreachable = await failure(() => {
      throw new TypeError("fetch failed");
    });
    expect(unreachable).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "B could not be reached. Try again later.",
    });
    expect(unreachable.details?.field).toBeUndefined();
    const html = await failure(
      () =>
        new Response("<!doctype html><p>Hello</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    expect(html).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "B did not answer like a Weaver instance.",
    });
    expect(html.details?.field).toBeUndefined();

    const id = "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b";
    await expect(
      send(
        json(201, {
          id,
          path: "p.md",
          slug: "p",
          url: "https://attacker.example/phishing",
        }),
      ),
    ).resolves.toEqual({
      id,
      path: "p.md",
      url: `${B}/projects/${target.id}/documents/${id}`,
    });
    await expect(
      fetchTransferTargets(stubbed(json(403, { error: "no" })), actor, {
        remoteInstanceId: remote.id,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("You cannot list projects on B"),
    });

    // A token refresh that cannot reach B is no reason to reconnect.
    await db.remoteInstanceConnection.updateMany({
      where: { remoteInstanceId: remote.id },
      data: { accessTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const refreshOffline = await rejection(
      sendWith({
        ...deps(),
        fetchImpl: (() =>
          Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
      }),
    );
    expect(refreshOffline).toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "B could not be reached. Try again later.",
    });
    expect(refreshOffline.details?.field).toBeUndefined();
  });

  it("maps B's 403 to FORBIDDEN, refuses a disabled remote, and needs Viewer on the source", async () => {
    const { db, actor, source, viewerOnly, remote } = await connected("errors");
    const doc = await createDocument(
      db,
      {
        projectId: source.id,
        folderPath: [],
        title: "P",
        content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
      },
      actor,
    );
    await expect(
      sendDocumentToRemote(deps(), actor, {
        remoteInstanceId: remote.id,
        projectId: source.id,
        documentId: doc.id,
        targetProjectId: viewerOnly.id,
        targetFolderPath: [],
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("B"),
    });
    await expect(
      sendDocumentToRemote(deps(), actor, {
        remoteInstanceId: remote.id,
        projectId: source.id,
        documentId: doc.id,
        targetProjectId: viewerOnly.id,
        targetFolderPath: ["nope"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.remoteInstance.update({
      where: { id: remote.id },
      data: { enabled: false },
    });
    await expect(
      sendDocumentToRemote(deps(), actor, {
        remoteInstanceId: remote.id,
        projectId: source.id,
        documentId: doc.id,
        targetProjectId: source.id,
        targetFolderPath: [],
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("disabled"),
    });
    const outsider = {
      ...securityContextFor(await makeUser("User", "send-errors-out")),
      name: "Out",
      email: "out@example.com",
    };
    await expect(
      sendDocumentToRemote(deps(), outsider, {
        remoteInstanceId: remote.id,
        projectId: source.id,
        documentId: doc.id,
        targetProjectId: source.id,
        targetFolderPath: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
