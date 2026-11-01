import { describe, expect, it } from "vitest";
import { prepareUploadFiles, uploadFiles } from "./upload";

describe("upload files", () => {
  it("infers an empty Markdown MIME and sends normalized file types", () => {
    const files = prepareUploadFiles(
      [
        new File(["# Title"], "notes.MD"),
        new File(["text"], "notes.txt", { type: "Text/Plain; charset=UTF-8" }),
      ],
      1024,
    );
    expect(files.map((file) => file.type)).toEqual([
      "text/markdown",
      "text/plain",
    ]);
  });
  it("does not override an explicitly unsupported MIME using the extension", () => {
    expect(() =>
      prepareUploadFiles(
        [new File(["data"], "notes.md", { type: "application/octet-stream" })],
        1024,
      ),
    ).toThrow(/unsupported/i);
    expect(() =>
      prepareUploadFiles([new File(["data"], "unknown.exe")], 1024),
    ).toThrow(/unsupported/i);
  });
  it("accepts the exact byte and file limits and rejects either excess", () => {
    const file = new File([new Uint8Array(1024)], "notes.txt", {
      type: "text/plain",
    });
    expect(
      prepareUploadFiles(
        Array.from({ length: 20 }, () => file),
        1024,
      ),
    ).toHaveLength(20);
    expect(() =>
      prepareUploadFiles(
        Array.from({ length: 21 }, () => file),
        1024,
      ),
    ).toThrow(/20/);
    expect(() => prepareUploadFiles([file], 1023)).toThrow(/larger/i);
  });
  it("sends the project before files and applies the base path", async () => {
    const result = await uploadFiles(
      "project",
      [new File(["# Title"], "notes.md")],
      1024,
      async (url, init) => {
        expect(url).toBe("/weaver/api/ingestion/uploads");
        expect(init?.method).toBe("POST");
        const form = init?.body as FormData;
        expect([...form.keys()]).toEqual(["projectId", "file"]);
        expect(form.get("projectId")).toBe("project");
        expect((form.get("file") as File).type).toBe("text/markdown");
        return Response.json({ batchId: "batch" }, { status: 201 });
      },
      "/weaver",
    );
    expect(result).toEqual({ kind: "uploaded", batchId: "batch" });
  });
  it("reports durable pending storage on 503 without uploading again", async () => {
    let requests = 0;
    const result = await uploadFiles(
      "project",
      [new File(["text"], "notes.txt")],
      1024,
      async () => {
        requests++;
        return Response.json(
          {
            error: "files stored but parse job publication failed",
            batchId: "saved",
          },
          { status: 503 },
        );
      },
    );
    expect(result).toEqual({ kind: "pending", batchId: "saved" });
    expect(requests).toBe(1);
  });
  it("settles network and malformed response failures and flags denied access", async () => {
    const files = [new File(["text"], "notes.txt")];
    expect(
      await uploadFiles("project", files, 1024, () =>
        Promise.reject(new Error("network")),
      ),
    ).toMatchObject({ kind: "error", accessDenied: false });
    expect(
      await uploadFiles("project", files, 1024, () =>
        Promise.resolve(new Response("bad gateway", { status: 502 })),
      ),
    ).toMatchObject({ kind: "error", accessDenied: false });
    expect(
      await uploadFiles("project", files, 1024, () =>
        Promise.resolve(Response.json({ error: "forbidden" }, { status: 403 })),
      ),
    ).toMatchObject({ kind: "error", accessDenied: true });
  });
});

it("normalizes CSV reported as Excel by Windows browsers", () => {
  expect(
    prepareUploadFiles(
      [new File(["a,b"], "rows.csv", { type: "application/vnd.ms-excel" })],
      1024,
    )[0]!.type,
  ).toBe("text/csv");
});
it("displays actionable server-authored validation errors", async () => {
  expect(
    await uploadFiles(
      "project",
      [new File(["text"], "notes.txt")],
      1024,
      async () =>
        Response.json(
          { error: "notes.txt exceeds the size limit" },
          { status: 413 },
        ),
    ),
  ).toMatchObject({ message: "notes.txt exceeds the size limit" });
});
