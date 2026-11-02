import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WikiInputView } from "@weaver/core/services/wikiInputs";
import { WikiInputScreen } from "./WikiInputScreen";

type MockQuery = { data: unknown; error: unknown };
type Mocked = {
  project: MockQuery;
  list: MockQuery;
  mutation: () => { useMutation: () => Record<string, unknown> };
};

const mocked = vi.hoisted((): Mocked => ({
  project: { data: undefined, error: null },
  list: { data: undefined, error: null },
  mutation: () => ({
    useMutation: () => ({
      mutate: () => undefined,
      mutateAsync: () => Promise.resolve(),
      isPending: false,
    }),
  }),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      wiki: { input: { list: { invalidate: () => undefined } } },
    }),
    project: { get: { useQuery: () => mocked.project } },
    wiki: {
      cancelRun: mocked.mutation(),
      input: {
        list: { useQuery: () => mocked.list },
        addText: mocked.mutation(),
        addFiles: mocked.mutation(),
        process: mocked.mutation(),
        retry: mocked.mutation(),
        confirm: mocked.mutation(),
        remove: mocked.mutation(),
        unlinkArtifact: mocked.mutation(),
      },
    },
  },
}));

const item = (over: Partial<WikiInputView>): WikiInputView => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "text",
  title: "Meeting notes",
  byteSize: 2048,
  status: "queued",
  createdAt: new Date(0),
  createdBy: "Anna",
  mine: false,
  outcomeNote: null,
  errorCode: null,
  errorMessage: null,
  heldHits: null,
  heldDigest: null,
  processedAt: null,
  sourceDocumentId: null,
  sourceTableId: null,
  revision: 0,
  ...over,
});

const listData = (over: Record<string, unknown> = {}) => ({
  queue: [],
  queuedCount: 0,
  attention: [],
  recent: [],
  activeRun: null,
  lastRun: null,
  queueLimit: 200,
  batchLimit: 10,
  ...over,
});

const render = () =>
  renderToStaticMarkup(<WikiInputScreen projectId="p" maxBytes={1024} />);

describe("WikiInputScreen", () => {
  beforeEach(() => {
    mocked.project = {
      data: { id: "p", name: "P", myRole: "Editor", wikiEnabled: true },
      error: null,
    };
    mocked.list = { data: listData(), error: null };
  });

  it("warns about history, remotes and the provider, and offers the note form", () => {
    const html = render();
    expect(html).toContain("permanent project history");
    expect(html).toContain("Git remote");
    expect(html).toContain("model provider");
    expect(html).toContain("Add to queue");
    expect(html).toContain("Browse files");
  });

  it("gives a Viewer the list without any action", () => {
    mocked.project = {
      data: { id: "p", name: "P", myRole: "Viewer", wikiEnabled: true },
      error: null,
    };
    mocked.list = {
      data: listData({
        queue: [item({})],
        attention: [
          item({
            id: "22222222-2222-4222-8222-222222222222",
            status: "failed",
            errorMessage: "could not read",
          }),
        ],
      }),
      error: null,
    };
    const html = render();
    expect(html).toContain("Meeting notes");
    expect(html).toContain("could not read");
    expect(html).not.toContain("Add to queue");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("Process");
  });

  it("words a missing runner plainly and never shows its code", () => {
    mocked.list = {
      data: listData({
        lastRun: {
          id: "r",
          kind: "ingest",
          status: "failed",
          errorCode: "RUNNER_UNAVAILABLE",
          errorMessage: "x",
          stopReason: null,
          startedAt: new Date(0),
          endedAt: new Date(0),
          items: 1,
        },
      }),
      error: null,
    };
    const html = render();
    expect(html).toContain("cannot run the wiki agent yet");
    expect(html).not.toContain("RUNNER_UNAVAILABLE");
  });

  it("shows a held item's finding and Confirm; Retry only on other items", () => {
    mocked.list = {
      data: listData({
        attention: [
          item({
            status: "held",
            title: "Note 2026-11-02",
            heldDigest: "a".repeat(64),
            heldHits: [{ kind: "jwt", location: "note, line 2" }],
          }),
        ],
      }),
      error: null,
    };
    const html = render();
    expect(html).toContain("JSON web token (note, line 2)");
    expect(html).toContain("Confirm");
    expect(html).not.toContain("Retry");
  });

  it("shows the owner an unlink action on file items only", () => {
    mocked.project = {
      data: { id: "p", name: "P", myRole: "Owner", wikiEnabled: true },
      error: null,
    };
    mocked.list = {
      data: listData({
        queue: [
          item({}),
          item({
            id: "33333333-3333-4333-8333-333333333333",
            kind: "file",
            title: "a.pdf",
          }),
        ],
      }),
      error: null,
    };
    expect(render().match(/Unlink file/g)).toHaveLength(1);
  });

  it("explains a disabled wiki and hides intake", () => {
    mocked.project = {
      data: { id: "p", name: "P", myRole: "Owner", wikiEnabled: false },
      error: null,
    };
    const html = render();
    expect(html).toContain("not enabled");
    expect(html).not.toContain("Add to queue");
  });

  it("shows only an access message on an access error", () => {
    mocked.list = {
      data: undefined,
      error: { data: { code: "NOT_FOUND" } },
    };
    expect(render()).toContain("do not have access");
  });
});
