import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Query = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => Promise<void>;
};

const mocked = vi.hoisted(() => {
  const query = (): Query => ({
    data: undefined,
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: () => Promise.resolve(),
  });
  return {
    project: query(),
    list: query(),
    listInput: undefined as Record<string, unknown> | undefined,
    invalidated: [] as unknown[],
    success: [] as string[],
  };
});

vi.mock("~/trpc/react", () => {
  const mutation = () => ({
    isPending: false,
    error: null,
    mutate: () => undefined,
    reset: () => undefined,
  });
  return {
    api: {
      project: { get: { useQuery: () => mocked.project } },
      artifact: {
        list: {
          useQuery: (input: Record<string, unknown>) => {
            mocked.listInput = input;
            return mocked.list;
          },
        },
        rename: { useMutation: () => mutation() },
        delete: { useMutation: () => mutation() },
      },
      useUtils: () => ({
        artifact: {
          list: {
            invalidate: (input: unknown) => {
              mocked.invalidated.push(input);
              return Promise.resolve();
            },
          },
        },
      }),
    },
  };
});
vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => mocked.success.push(message),
    error: () => undefined,
  },
}));
vi.mock("~/env", () => ({
  env: {
    WEAVER_INGESTION_MAX_FILE_BYTES: 2048,
    WEAVER_ARTIFACT_MAX_FILE_BYTES: 4096,
  },
}));

import { listArtifactsInput } from "~/server/api/schemas/artifact";
import { ArtifactsScreen } from "./ArtifactsScreen";
import ArtifactsPage from "../page";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const artifact = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: PROJECT,
  filename: "Plan.docx",
  contentType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  byteSize: 2048,
  contentDigest: "a".repeat(64),
  createdAt: new Date("2026-09-20T10:00:00Z"),
  updatedAt: new Date("2026-09-20T10:00:00Z"),
  uploadedBy: { id: "u", name: "Ada", email: "ada@test.local" },
};
const listPage = (items: (typeof artifact)[], pageCount = 1) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  pageCount,
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const render = (focusFilename: string | null = null) =>
  renderToStaticMarkup(
    <ArtifactsScreen
      projectId={PROJECT}
      maxFileBytes={2048}
      focusFilename={focusFilename}
    />,
  );

describe("ArtifactsScreen", () => {
  beforeEach(() => {
    for (const query of [mocked.project, mocked.list]) {
      query.data = undefined;
      query.error = null;
      query.isLoading = false;
      query.isFetching = false;
    }
    mocked.project.data = { id: PROJECT, name: "Demo", myRole: "Editor" };
    mocked.list.data = listPage([artifact]);
    mocked.listInput = undefined;
    mocked.invalidated = [];
    mocked.success = [];
  });

  it("lists files with the first page, default sort and the pager", () => {
    const html = render();
    expect(html).toContain("Plan.docx");
    expect(html).toContain("Page 1 of 1");
    expect(mocked.listInput).toMatchObject({
      projectId: PROJECT,
      page: 1,
      pageSize: 25,
      sort: "filename",
      dir: "asc",
    });
    expect(mocked.listInput).not.toHaveProperty("search");
  });

  it("carries the focus filename as search on the very first list request", () => {
    const html = render("Plan.docx");
    expect(html).toContain("Plan.docx");
    expect(mocked.listInput).toMatchObject({
      projectId: PROJECT,
      page: 1,
      search: "Plan.docx",
    });
  });

  it("seeds the search from a long deep link with a term the router still accepts", () => {
    const long = `${"a".repeat(250)}.docx`.slice(0, 255);
    mocked.list.data = listPage([{ ...artifact, filename: long }]);
    const html = render(long);
    expect(mocked.listInput).toMatchObject({ search: long.slice(0, 200) });
    expect(() => listArtifactsInput.parse(mocked.listInput)).not.toThrow();
    // The highlight still keys on the whole filename, not the search term.
    expect(html).toContain("data-focused");
  });

  describe("typed search", () => {
    const renderers: ReactTestRenderer[] = [];
    afterEach(() => {
      for (const renderer of renderers.splice(0)) renderer.unmount();
      vi.useRealTimers();
    });

    it("caps the input at 200 characters and slices a longer typed term before it reaches the router", async () => {
      vi.useFakeTimers();
      // No rows: the row-actions menu needs a DOM `document` the node environment lacks.
      mocked.list.data = listPage([]);
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <ArtifactsScreen
            projectId={PROJECT}
            maxFileBytes={2048}
            focusFilename={null}
          />,
        );
      });
      renderers.push(renderer);
      const input = renderer.root.findByProps({ id: "artifact-search" });
      expect(input.props.maxLength).toBe(200);
      const long = `${"b".repeat(240)}.docx`;
      await act(async () => {
        (input.props.onChange as (e: unknown) => void)({
          target: { value: long },
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(mocked.listInput).toMatchObject({ search: long.slice(0, 200) });
      expect((mocked.listInput!.search as string).length).toBe(200);
      expect(() => listArtifactsInput.parse(mocked.listInput)).not.toThrow();
    });
  });

  it("re-renders against a changed page count without losing the pager", () => {
    mocked.list.data = listPage([artifact], 3);
    const html = render();
    expect(html).toContain("Page 1 of 3");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/);
  });

  it("passes the awaited project and focus file through the route", async () => {
    const page = await ArtifactsPage({
      params: Promise.resolve({ projectId: PROJECT }),
      searchParams: Promise.resolve({ file: "Plan.docx" }),
    });
    expect(page.props).toMatchObject({
      projectId: PROJECT,
      maxFileBytes: 4096,
      focusFilename: "Plan.docx",
    });
    const repeated = await ArtifactsPage({
      params: Promise.resolve({ projectId: PROJECT }),
      searchParams: Promise.resolve({ file: ["a", "b"] }),
    });
    expect(repeated.props).toMatchObject({ focusFilename: null });
  });

  it("keys the screen on both project and focus file so a new deep link remounts it", async () => {
    const forA = await ArtifactsPage({
      params: Promise.resolve({ projectId: PROJECT }),
      searchParams: Promise.resolve({ file: "a.docx" }),
    });
    const forB = await ArtifactsPage({
      params: Promise.resolve({ projectId: PROJECT }),
      searchParams: Promise.resolve({ file: "b.docx" }),
    });
    expect(forA.key).not.toBe(forB.key);
    expect(forA.key).toContain(PROJECT);
    expect(forA.key).toContain("a.docx");
    const arrayFile = await ArtifactsPage({
      params: Promise.resolve({ projectId: PROJECT }),
      searchParams: Promise.resolve({ file: ["a", "b"] }),
    });
    expect(arrayFile.props).toMatchObject({ focusFilename: null });
    expect(arrayFile.key).toBe(`${PROJECT}:`);
  });

  it.each(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"])(
    "hides cached rows, actions and the pager after a %s list error",
    (code) => {
      mocked.list.error = { data: { code } };
      const html = render();
      expect(html).not.toContain("Plan.docx");
      expect(html).not.toContain("Page 1 of");
      expect(html).not.toContain("Actions for");
      expect(html).toContain("Could not load files.");
    },
  );

  it("keeps the last loaded rows visible after a transient refresh error", () => {
    mocked.list.error = new Error("network");
    const html = render();
    expect(html).toContain("Plan.docx");
    expect(html).toContain("could not refresh");
  });

  it("shows the empty-project card without a search term", () => {
    mocked.list.data = listPage([]);
    const html = render();
    expect(html).toContain("No files yet");
    expect(html).not.toContain("No matching files");
  });

  it("shows a skeleton while the first page loads", () => {
    mocked.list.data = undefined;
    mocked.list.isLoading = true;
    const html = render();
    expect(html).not.toContain("No files yet");
    expect(html).not.toContain("Page 1 of");
  });

  it("offers no upload area, rename or delete controls to a Viewer", () => {
    mocked.project.data = { id: PROJECT, name: "Demo", myRole: "Viewer" };
    const html = render();
    expect(html).toContain("Plan.docx");
    expect(html).not.toContain("Actions for");
    expect(html).not.toContain('aria-label="Upload files"');
  });

  it("offers the upload area and row actions to an Editor and hides both after a project access error", () => {
    const html = render();
    expect(html).toContain("Actions for Plan.docx");
    expect(html).toContain('aria-label="Upload files"');
    expect(html).toContain("Up to 20 files");
    mocked.project.error = { data: { code: "FORBIDDEN" } };
    const denied = render();
    expect(denied).not.toContain("Actions for");
    expect(denied).not.toContain('aria-label="Upload files"');
  });
});
