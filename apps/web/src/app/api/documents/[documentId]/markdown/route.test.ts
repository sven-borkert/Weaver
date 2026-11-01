import { CoreError } from "@weaver/core/errors";
import { readDocumentFile } from "@weaver/core/services/documentDownload";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUser } from "~/server/auth";

vi.mock("~/server/auth", () => ({ getSessionUser: vi.fn() }));
vi.mock("@weaver/db", () => ({ db: {} }));
vi.mock("@weaver/core/services/documentDownload", () => ({
  readDocumentFile: vi.fn(),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const USER = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "viewer@test.local",
  name: "Viewer",
  role: "User" as const,
  sessionId: "44444444-4444-4444-8444-444444444444",
  mustChangePassword: false,
};

async function get(
  documentId = DOCUMENT_ID,
  query = `?projectId=${PROJECT_ID}`,
) {
  const { GET } = await import("./route");
  return GET(
    new Request(
      `http://localhost:3000/api/documents/${documentId}/markdown${query}`,
    ) as never,
    { params: Promise.resolve({ documentId }) },
  );
}

describe("GET /api/documents/{documentId}/markdown", () => {
  beforeEach(() => {
    vi.mocked(getSessionUser).mockReset().mockResolvedValue(USER);
    vi.mocked(readDocumentFile).mockReset();
  });

  it("serves the stored file unchanged as a named attachment", async () => {
    const bytes = Buffer.from("<!-- weaver\n-->\n\n# Plän\r\n");
    vi.mocked(readDocumentFile).mockResolvedValue({
      bytes,
      fileName: "plan.md",
      mimeType: "text/markdown",
    });

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"plan.md\"; filename*=UTF-8''plan.md",
    );
    expect(response.headers.get("content-length")).toBe(
      String(bytes.byteLength),
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    expect(vi.mocked(readDocumentFile).mock.calls[0]?.[1]).toEqual({
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
    });
    expect(vi.mocked(readDocumentFile).mock.calls[0]?.[2]).toMatchObject({
      userId: USER.id,
    });
  });

  it("refuses a request without a session before reading anything", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    expect((await get()).status).toBe(401);
    expect(readDocumentFile).not.toHaveBeenCalled();
  });

  it("answers 404 for malformed ids without reading anything", async () => {
    expect((await get("not-a-uuid")).status).toBe(404);
    expect((await get(DOCUMENT_ID, "")).status).toBe(404);
    expect(readDocumentFile).not.toHaveBeenCalled();
  });

  it.each(["NOT_FOUND", "FORBIDDEN"] as const)(
    "hides a %s document as 404",
    async (code) => {
      vi.mocked(readDocumentFile).mockRejectedValue(new CoreError(code));

      const response = await get();

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    },
  );
});
