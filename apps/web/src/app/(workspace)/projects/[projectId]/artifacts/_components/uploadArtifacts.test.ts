import { describe, expect, it, vi } from "vitest";

import { uploadArtifacts } from "./uploadArtifacts";

const files = [new File(["x"], "x.txt")];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe("uploadArtifacts", () => {
  it("posts projectId, replace fields, then files to the project route", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(201, { artifacts: [{}] }));
    const result = await uploadArtifacts("p1", files, ["x.txt"], {
      fetchImpl,
      basePath: "/weaver",
    });
    expect(result).toEqual({ kind: "uploaded", count: 1, ids: [] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/weaver/api/projects/p1/artifacts");
    const form = init!.body as FormData;
    expect([...form.keys()]).toEqual(["projectId", "replace", "file"]);
    expect(form.get("projectId")).toBe("p1");
    expect(init!.method).toBe("POST");
  });

  it("returns the conflicting names on 409 and a readable message otherwise", async () => {
    const conflict = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(409, { error: "exists", conflicts: ["x.txt"] }));
    expect(
      await uploadArtifacts("p1", files, [], { fetchImpl: conflict }),
    ).toEqual({ kind: "conflict", conflicts: ["x.txt"] });
    const denied = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(404, { error: "not found" }));
    expect(
      await uploadArtifacts("p1", files, [], { fetchImpl: denied }),
    ).toMatchObject({ kind: "error", accessDenied: true });
    const sniff = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(415, { error: "fake.docx is not a valid …" }));
    expect(
      await uploadArtifacts("p1", files, [], { fetchImpl: sniff }),
    ).toMatchObject({ kind: "error", message: "fake.docx is not a valid …" });
  });

  it("omits replace fields when nothing is replaced and defaults the count", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(201, {}));
    expect(await uploadArtifacts("p1", files, [], { fetchImpl })).toEqual({
      kind: "uploaded",
      count: 1,
      ids: [],
    });
    const form = fetchImpl.mock.calls[0]![1]!.body as FormData;
    expect([...form.keys()]).toEqual(["projectId", "file"]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/projects/p1/artifacts");
  });

  it("hides unreadable server failures behind a generic message", async () => {
    const broken = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("gateway", { status: 502 }));
    expect(
      await uploadArtifacts("p1", files, [], { fetchImpl: broken }),
    ).toEqual({
      kind: "error",
      message: "Could not upload the files. Try again.",
      accessDenied: false,
    });
    for (const conflictBody of [{ error: "exists" }, { conflicts: [] }])
      expect(
        await uploadArtifacts("p1", files, [], {
          fetchImpl: vi
            .fn<typeof fetch>()
            .mockResolvedValue(json(409, conflictBody)),
        }),
      ).toMatchObject({ kind: "error", accessDenied: false });
  });

  it("settles an interrupted or cancelled request as an error result", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network"));
    expect(
      await uploadArtifacts("p1", files, [], { fetchImpl: network }),
    ).toMatchObject({ kind: "error", accessDenied: false });
    const controller = new AbortController();
    controller.abort();
    const aborted = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("Upload cancelled", "AbortError"));
    expect(
      await uploadArtifacts("p1", files, [], {
        fetchImpl: aborted,
        signal: controller.signal,
      }),
    ).toMatchObject({ kind: "error" });
    expect(aborted.mock.calls[0]![1]!.signal).toBe(controller.signal);
  });
});
