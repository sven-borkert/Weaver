import { afterAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { readPdfPages } from "@weaver/artifact-readers/pdf";
import {
  createPdfRenderer,
  launchChromium,
} from "~/server/documents/pdf/render";
import {
  exportDocumentPdf,
  PdfLimitError,
} from "~/server/documents/pdf/export";

const renderer = createPdfRenderer({ timeoutMs: 30_000 });
afterAll(() => renderer.close());

describe("renderDocumentPdf", () => {
  it("prints a page with the page footer", async () => {
    const bytes = await renderer.render(
      `<!doctype html><html data-weaver-ready="true"><body><h1>Hello PDF</h1><p>Body text.</p></body></html>`,
    );
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const pages = await readPdfPages(bytes);
    expect(pages.pageCount).toBe(1);
    expect(pages.pages[0]!.text).toContain("Hello PDF");
    expect(pages.pages[0]!.text).toContain("1 / 1");
  });

  it("relaunches Chromium after the browser disconnects", async () => {
    const launched: Browser[] = [];
    const own = createPdfRenderer({
      timeoutMs: 30_000,
      launch: async () => {
        const instance = await launchChromium();
        launched.push(instance);
        return instance;
      },
    });
    try {
      const page = `<!doctype html><html data-weaver-ready="true"><body>again</body></html>`;
      await own.render(page);
      // Simulate a crash: the cached browser goes away underneath the renderer.
      await launched[0]!.close();
      const bytes = await own.render(page);
      expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
      expect(launched).toHaveLength(2);
    } finally {
      await own.close();
    }
  });

  it("times out on a page that never becomes ready", async () => {
    await expect(
      renderer.render(`<!doctype html><html><body>never ready</body></html>`, {
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("PDF render timed out");
  });
});

import { afterEach, beforeEach, vi } from "vitest";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import {
  createDocument,
  getDocument,
  saveDocument,
} from "@weaver/core/services/documents";
import { storeDocumentImage } from "@weaver/core/services/documentImages";
import { getSessionUser, type SessionUser } from "~/server/auth";
import {
  addMembership,
  getPrisma,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  testAuth,
  TEST_PASSWORD,
} from "./_harness";

async function sessionCookieFor(email: string): Promise<string> {
  const response = await testAuth().api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    asResponse: true,
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  expect(cookie).toMatch(/session_token=/);
  return cookie!;
}

// The route reads the session through the mocked ~/server/auth; resolve it from the real Better Auth instance.
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

const ONE_PIXEL_PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
  156, 99, 248, 255, 255, 63, 0, 5, 254, 2, 254, 167, 53, 129, 132, 0, 0, 0, 0,
  73, 69, 78, 68, 174, 66, 96, 130,
]);

describe("GET /api/documents/{documentId}/pdf", () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(getSessionUser).mockImplementation(resolveTestSession);
  });
  afterEach(() =>
    vi.mocked(getSessionUser).mockImplementation(() => Promise.resolve(null)),
  );

  async function fixture(suffix: string) {
    const db = getPrisma();
    const viewer = await makeUser("User", `pdf-${suffix}-viewer`);
    const editor = await makeUser("User", `pdf-${suffix}-editor`);
    const outsider = await makeUser("User", `pdf-${suffix}-out`);
    const project = await makeProject(`Pdf ${suffix}`);
    await addMembership(project.id, viewer.id, "Viewer");
    await addMembership(project.id, editor.id, "Editor");
    const actor = {
      ...securityContextFor(editor),
      name: "Editor",
      email: editor.email,
    };
    return { db, viewer, editor, outsider, project, actor };
  }

  async function get(documentId: string, projectId: string, cookie?: string) {
    const route = await import("~/app/api/documents/[documentId]/pdf/route");
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    return route.GET(
      new Request(
        `http://localhost:3000/api/documents/${documentId}/pdf?projectId=${projectId}`,
        { headers },
      ) as never,
      { params: Promise.resolve({ documentId }) },
    );
  }

  it("streams a PDF of the saved revision with an image, a table and a diagram", async () => {
    const { db, viewer, project, actor } = await fixture("ok");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Quarterly Plan",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("## Goals\n\nFirst draft.\n"),
        },
      },
      actor,
    );
    const stored = await storeDocumentImage(
      db,
      {
        projectId: project.id,
        documentId: created.id,
        fileName: "chart.png",
        bytes: ONE_PIXEL_PNG,
      },
      actor,
    );
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      actor,
    );
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: created.id,
        baseCommitSha: read.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(
            `## Goals\n\n![Chart](${stored.src})\n\n| A | B |\n| - | - |\n| one | two |\n\n\`\`\`mermaid\ngraph TD; Start-->Done\n\`\`\`\n`,
          ),
        },
        changeSummary: "",
      },
      actor,
    );

    const response = await get(
      created.id,
      project.id,
      await sessionCookieFor(viewer.email),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="quarterly-plan.pdf"',
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pages = await readPdfPages(bytes);
    expect(pages.pageCount).toBe(1);
    expect(pages.pages[0]!.text).toContain("Quarterly Plan");
    expect(pages.pages[0]!.text).toContain("Goals");
    expect(pages.pages[0]!.text).toContain("one");
    expect(pages.pages[0]!.text).toContain("Created ");
    // The diagram was rendered: its source is no longer printed as text.
    expect(pages.pages[0]!.text).not.toContain("graph TD");
  });

  it("renders a placeholder for a missing image", async () => {
    const { db, viewer, project, actor } = await fixture("missing");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Gap",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody("![Lost](gap.assets/lost.png)\n"),
        },
      },
      actor,
    );
    const response = await get(
      created.id,
      project.id,
      await sessionCookieFor(viewer.email),
    );
    expect(response.status).toBe(200);
    const pages = await readPdfPages(
      new Uint8Array(await response.arrayBuffer()),
    );
    expect(pages.pages[0]!.text).toContain(
      "Image unavailable: gap.assets/lost.png",
    );
  });

  it("keeps a broken Mermaid block as source", async () => {
    const { db, viewer, project, actor } = await fixture("mermaid");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Broken diagram",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(
            "```mermaid\nthis is not mermaid\n```\n",
          ),
        },
      },
      actor,
    );
    const response = await get(
      created.id,
      project.id,
      await sessionCookieFor(viewer.email),
    );
    expect(response.status).toBe(200);
    const pages = await readPdfPages(
      new Uint8Array(await response.arrayBuffer()),
    );
    expect(pages.pages[0]!.text).toContain("this is not mermaid");
    // Mermaid's own error graphic must not be appended to the page.
    expect(pages.pages[0]!.text).not.toContain("Syntax error in text");
  });

  it("refuses images above the byte cap", async () => {
    const { db, project, actor } = await fixture("bytes");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Heavy",
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
        projectId: project.id,
        documentId: created.id,
        fileName: "chart.png",
        bytes: ONE_PIXEL_PNG,
      },
      actor,
    );
    const read = await getDocument(
      db,
      { projectId: project.id, documentId: created.id },
      actor,
    );
    await saveDocument(
      db,
      {
        projectId: project.id,
        documentId: created.id,
        baseCommitSha: read.baseCommitSha,
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(`![Chart](${stored.src})\n`),
        },
        changeSummary: "",
      },
      actor,
    );
    await expect(
      exportDocumentPdf(
        db,
        { projectId: project.id, documentId: created.id },
        actor,
        { maxImageBytes: ONE_PIXEL_PNG.length - 1 },
      ),
    ).rejects.toBeInstanceOf(PdfLimitError);
  });

  it("hides the document from non-members, rejects a malformed id, and needs a session", async () => {
    const { db, outsider, project, actor } = await fixture("access");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Private",
        content: { kind: "markdown", contentJson: parseDocumentBody("x\n") },
      },
      actor,
    );
    const cookie = await sessionCookieFor(outsider.email);
    expect((await get(created.id, project.id, cookie)).status).toBe(404);
    expect((await get("not-a-uuid", project.id, cookie)).status).toBe(404);
    expect((await get(created.id, project.id)).status).toBe(401);
  });

  it("refuses a document above the image cap with 413", async () => {
    const { db, viewer, project, actor } = await fixture("cap");
    const links = Array.from(
      { length: 101 },
      (_, i) => `![i${i}](cap.assets/i${i}.png)`,
    ).join("\n\n");
    const created = await createDocument(
      db,
      {
        projectId: project.id,
        folderPath: [],
        title: "Cap",
        content: {
          kind: "markdown",
          contentJson: parseDocumentBody(`${links}\n`),
        },
      },
      actor,
    );
    const response = await get(
      created.id,
      project.id,
      await sessionCookieFor(viewer.email),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("100 images"),
    });
  });
});
