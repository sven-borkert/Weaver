import { Readable } from "node:stream";
import { CoreError } from "@weaver/core/errors";
import { createFolderArchive } from "@weaver/core/services/documentDownload";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUser } from "~/server/auth";

vi.mock("~/server/auth", () => ({ getSessionUser: vi.fn() }));
vi.mock("@weaver/db", () => ({ db: {} }));
vi.mock("@weaver/core/services/documentDownload", () => ({
  createFolderArchive: vi.fn(),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const USER = {
  id: "33333333-3333-4333-8333-333333333333",
  email: "viewer@test.local",
  name: "Viewer",
  role: "User" as const,
  sessionId: "44444444-4444-4444-8444-444444444444",
  mustChangePassword: false,
};

async function get(query = "", projectId = PROJECT_ID) {
  const { GET } = await import("./route");
  return GET(
    new Request(
      `http://localhost:3000/api/projects/${projectId}/folders/archive${query}`,
    ) as never,
    { params: Promise.resolve({ projectId }) },
  );
}

describe("GET /api/projects/{projectId}/folders/archive", () => {
  beforeEach(() => {
    vi.mocked(getSessionUser).mockReset().mockResolvedValue(USER);
    vi.mocked(createFolderArchive).mockReset();
  });

  it("streams the folder archive as a named ZIP attachment", async () => {
    vi.mocked(createFolderArchive).mockResolvedValue({
      stream: Readable.from([Buffer.from("PK"), Buffer.from([0x03, 0x04])]),
      fileName: "deep.zip",
    });

    const response = await get("?path=notes/deep");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"deep.zip\"; filename*=UTF-8''deep.zip",
    );
    expect(
      Buffer.from(await response.arrayBuffer()).equals(
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      ),
    ).toBe(true);
    expect(vi.mocked(createFolderArchive).mock.calls[0]?.[1]).toEqual({
      projectId: PROJECT_ID,
      folderPath: ["notes", "deep"],
    });
    expect(vi.mocked(createFolderArchive).mock.calls[0]?.[2]).toMatchObject({
      userId: USER.id,
    });
  });

  it("archives the project root when no path is given", async () => {
    vi.mocked(createFolderArchive).mockResolvedValue({
      stream: Readable.from([Buffer.from("PK")]),
      fileName: "demo.zip",
    });

    expect((await get()).status).toBe(200);
    expect(vi.mocked(createFolderArchive).mock.calls[0]?.[1]).toEqual({
      projectId: PROJECT_ID,
      folderPath: [],
    });
  });

  it("refuses a request without a session before reading anything", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    expect((await get("?path=notes")).status).toBe(401);
    expect(createFolderArchive).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed project id", async () => {
    expect((await get("?path=notes", "not-a-uuid")).status).toBe(404);
    expect(createFolderArchive).not.toHaveBeenCalled();
  });

  it.each(["NOT_FOUND", "FORBIDDEN"] as const)(
    "hides a %s folder as 404",
    async (code) => {
      vi.mocked(createFolderArchive).mockRejectedValue(new CoreError(code));

      const response = await get("?path=notes");

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    },
  );

  it("answers 413 for a folder over the download limit", async () => {
    vi.mocked(createFolderArchive).mockRejectedValue(
      new CoreError("BAD_REQUEST", "folder is too large to download", {
        reason: "PAYLOAD_TOO_LARGE",
      }),
    );

    const response = await get("?path=notes");

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "folder is too large to download",
    });
  });
});
