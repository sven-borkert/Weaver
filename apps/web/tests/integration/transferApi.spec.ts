import { beforeEach, describe, expect, it, vi } from "vitest";
import { simpleGit } from "simple-git";
import { createBearerVerifiers } from "@weaver/auth";
import { repoDir } from "@weaver/git-store";
import { getDocument, listDocuments } from "@weaver/core/services/documents";
import { getTable } from "@weaver/core/services/tables";
import { getBearerVerifiers } from "~/server/auth/bearer";
import {
  addMembership,
  ensureOAuthResource,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  TEST_ISSUER,
  TEST_MCP_RESOURCE,
  testAuth,
  markdownContent,
} from "./_harness";
import {
  insertOAuthClient,
  obtainAccessToken,
  sessionCookieFor,
} from "./_oauth";

vi.mock("~/server/auth/bearer", () => ({ getBearerVerifiers: vi.fn() }));

const ONE_PIXEL_PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
  156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0,
  73, 69, 78, 68, 174, 66, 96, 130,
]);

async function routes() {
  return {
    whoami: (await import("~/app/api/transfer/whoami/route")).GET,
    targets: (await import("~/app/api/transfer/targets/route")).GET,
    targetFolders: (
      await import("~/app/api/transfer/targets/[projectId]/route")
    ).GET,
    documents: (await import("~/app/api/transfer/documents/route")).POST,
    tables: (await import("~/app/api/transfer/tables/route")).POST,
  };
}

function call(
  path: string,
  token: string | null,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return new Request(`http://localhost:3000/api/transfer/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function fixture(suffix: string, scope?: string) {
  await resetDb();
  await ensureOAuthResource();
  await insertOAuthClient();
  const db = getPrisma();
  const editor = await makeUser("User", `transfer-${suffix}-editor`);
  const viewerProject = await makeProject(`Transfer ${suffix} viewer-only`);
  const project = await makeProject(`Transfer ${suffix}`);
  await addMembership(project.id, editor.id, "Editor");
  await addMembership(viewerProject.id, editor.id, "Viewer");
  const { access_token } = await obtainAccessToken(
    await sessionCookieFor(editor.email),
    scope,
  );
  return {
    db,
    editor,
    project,
    viewerProject,
    token: access_token,
    r: await routes(),
  };
}

describe("transfer API", () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(getBearerVerifiers).mockImplementation(() =>
      createBearerVerifiers(testAuth(), {
        issuer: TEST_ISSUER,
        audience: TEST_MCP_RESOURCE,
      }),
    );
  });

  it("identifies the token's user and lists writable projects with their folders", async () => {
    const { editor, project, viewerProject, token, r } =
      await fixture("targets");
    const who = await r.whoami(call("whoami", token));
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({
      userId: editor.id,
      email: editor.email,
    });

    const targets = await r.targets(call("targets", token));
    const { projects } = (await targets.json()) as {
      projects: Array<{ id: string; myRole: string }>;
    };
    expect(projects.map((p) => p.id)).toEqual([project.id]);
    expect(projects.map((p) => p.id)).not.toContain(viewerProject.id);

    const folders = await r.targetFolders(
      call(`targets/${project.id}`, token),
      { params: Promise.resolve({ projectId: project.id }) },
    );
    expect(folders.status).toBe(200);
    expect(await folders.json()).toEqual({
      documents: { folders: [], folderNames: {} },
      tables: { folders: [], folderNames: {} },
    });
    expect((await r.whoami(call("whoami", null))).status).toBe(401);
    expect((await r.whoami(call("whoami", "not-a-token"))).status).toBe(401);
  });

  it("transferred_table_keeps_appearance", async () => {
    const { db, editor, project, token, r } = await fixture("styled-table");
    const { imageIconFromBytes } =
      await import("@weaver/core/services/appearanceAssets");
    const icon = imageIconFromBytes(ONE_PIXEL_PNG);
    const appearance = { backgroundColor: "#123456", icon };
    const response = await r.tables(
      call("tables", token, {
        projectId: project.id,
        folderPath: [],
        title: "Styled",
        columns: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Name",
            type: "text",
          },
        ],
        rows: [],
        appearance,
        iconAssets: [
          {
            digest: icon.digest,
            extension: icon.extension,
            bytes: ONE_PIXEL_PNG.toString("base64"),
          },
        ],
      }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const table = await getTable(
      db,
      { projectId: project.id, tableId: created.id },
      securityContextFor(editor),
    );
    expect(table.appearance).toEqual(appearance);
  });

  it("rejects tampered transferred icons before a content commit", async () => {
    const { db, project, token, r } = await fixture("tampered-transfer");
    const icon = { type: "image", digest: "a".repeat(64), extension: "png" };
    const response = await r.documents(
      call("documents", token, {
        projectId: project.id,
        folderPath: [],
        title: "Rejected",
        markdown: "x",
        assetsSlug: "x",
        images: [],
        appearance: { icon },
        iconAssets: [
          {
            digest: icon.digest,
            extension: icon.extension,
            bytes: ONE_PIXEL_PNG.toString("base64"),
          },
        ],
      }),
    );
    expect(response.status).toBe(400);
    expect(await db.document.count({ where: { projectId: project.id } })).toBe(
      0,
    );
    const { openProjectRepo } = await import("@weaver/git-store");
    expect(await openProjectRepo(project.id)).toBeNull();
  });

  it("creates a document with its images as the token's user", async () => {
    const { db, editor, project, token, r } = await fixture("document");
    const response = await r.documents(
      call("documents", token, {
        projectId: project.id,
        folderPath: [],
        title: "Sent over",
        markdown:
          "# Ignored heading\n\nText.\n\n![Chart](plan.assets/chart.png)\n",
        assetsSlug: "plan",
        images: [
          {
            name: "chart.png",
            contentType: "image/png",
            bytes: ONE_PIXEL_PNG.toString("base64"),
          },
        ],
      }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      id: string;
      path: string;
      url: string;
    };
    expect(created.url).toBe(
      `http://localhost:3000/projects/${project.id}/documents/${created.id}`,
    );
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      securityContextFor(editor),
    );
    expect(read.title).toBe("Sent over");
    expect(read.createdBy).toEqual({ id: editor.id, name: expect.any(String) });
    const log = await simpleGit(repoDir(project.id)).raw([
      "log",
      "-1",
      "--format=%B",
    ]);
    expect(log).toContain(`Weaver-User-Id: ${editor.id}`);
    expect(
      await simpleGit(repoDir(project.id)).raw([
        "show",
        "HEAD:sent-over.assets/chart.png",
      ]),
    ).toBeTruthy();
    expect(
      (
        await listDocuments(
          db,
          {
            projectId: project.id,
            page: 1,
            pageSize: 10,
            sort: "title",
            dir: "asc",
          },
          securityContextFor(editor),
        )
      ).items,
    ).toHaveLength(1);
  });

  it("creates the document when a linked image is not in the payload", async () => {
    const { db, editor, project, token, r } = await fixture("noimage");
    const response = await r.documents(
      call("documents", token, {
        projectId: project.id,
        folderPath: [],
        title: "Lonely link",
        markdown: "![Gone](plan.assets/gone.png)\n",
        assetsSlug: "plan",
        images: [],
      }),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: id },
      securityContextFor(editor),
    );
    expect(JSON.stringify(markdownContent(read))).toContain(
      "lonely-link.assets/gone.png",
    );
  });

  it("creates a table with its columns and rows", async () => {
    const { db, editor, project, token, r } = await fixture("table");
    const columnId = "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c";
    const response = await r.tables(
      call("tables", token, {
        projectId: project.id,
        folderPath: [],
        title: "Inventory",
        columns: [{ id: columnId, name: "Item", type: "text" }],
        rows: [
          {
            id: "0b0e7c1a-5a4e-4a8e-9b1f-2c3d4e5f6a7b",
            cells: { [columnId]: "Widget" },
          },
        ],
      }),
    );
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const table = await getTable(
      db,
      { projectId: project.id, tableId: id },
      securityContextFor(editor),
    );
    expect(table.rows).toHaveLength(1);
    expect(table.columns[0]!.name).toBe("Item");
  });

  it("refuses a Viewer with 403, an outsider with 404, and a read-only scope with 403", async () => {
    const { project, viewerProject, token, r } = await fixture("access");
    const payload = (projectId: string) => ({
      projectId,
      folderPath: [],
      title: "X",
      markdown: "x\n",
      assetsSlug: "x",
      images: [],
    });
    expect(
      (await r.documents(call("documents", token, payload(viewerProject.id))))
        .status,
    ).toBe(403);
    const other = await makeProject("Transfer access outsider");
    expect(
      (await r.documents(call("documents", token, payload(other.id)))).status,
    ).toBe(404);
    const readOnly = await fixture("readonly", "mcp:use content:read");
    expect(
      (
        await readOnly.r.documents(
          call("documents", readOnly.token, payload(readOnly.project.id)),
        )
      ).status,
    ).toBe(403);
    void project;
  });

  it("enforces the body, image count, image size, name and folder rules", async () => {
    const { project, token, r } = await fixture("limits");
    const base = {
      projectId: project.id,
      folderPath: [] as string[],
      title: "L",
      markdown: "x\n",
      assetsSlug: "l",
    };
    const image = {
      name: "a.png",
      contentType: "image/png",
      bytes: ONE_PIXEL_PNG.toString("base64"),
    };
    expect(
      (
        await r.documents(
          call(
            "documents",
            token,
            { ...base, images: [] },
            { "content-length": String(65 * 1024 * 1024) },
          ),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await r.documents(
          call("documents", token, {
            ...base,
            images: Array.from({ length: 101 }, (_, i) => ({
              ...image,
              name: `i${i}.png`,
            })),
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await r.documents(
          call("documents", token, {
            ...base,
            images: [{ ...image, name: "../evil.png" }],
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await r.documents(
          call("documents", token, {
            ...base,
            images: [
              {
                ...image,
                contentType: "image/png",
                bytes: Buffer.from("not a png").toString("base64"),
              },
            ],
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await r.documents(
          call("documents", token, {
            ...base,
            folderPath: ["missing"],
            images: [],
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await r.tables(
          call("tables", token, {
            projectId: project.id,
            folderPath: [],
            title: "T",
            columns: [],
            rows: [],
          }),
        )
      ).status,
    ).toBe(400);
  });
});
