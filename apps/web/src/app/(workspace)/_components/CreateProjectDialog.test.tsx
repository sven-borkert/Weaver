import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HistoryTrackerHost } from "~/lib/use-unsaved-changes-guard";

const mocked = vi.hoisted(() => ({
  onSuccess: undefined as ((project: { id: string }) => void) | undefined,
  push: vi.fn(),
  invalidate: vi.fn(),
  basePath: "",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocked.push }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/lib/basePath", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/basePath")>();
  return {
    ...actual,
    withBasePath: (path: string) => actual.withBasePath(path, mocked.basePath),
  };
});
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ project: { list: { invalidate: mocked.invalidate } } }),
    project: {
      create: {
        useMutation: (options: { onSuccess: typeof mocked.onSuccess }) => {
          mocked.onSuccess = options.onSuccess;
          return { isPending: false, mutate: vi.fn() };
        },
      },
    },
  },
}));

import { CreateProjectDialog } from "./CreateProjectDialog";

const host = globalThis as typeof globalThis & HistoryTrackerHost;
let previousGuard: HistoryTrackerHost["__weaverNavigationGuard"];

describe("project creation navigation", () => {
  beforeEach(() => {
    previousGuard = host.__weaverNavigationGuard;
    mocked.push.mockClear();
    mocked.invalidate.mockClear();
    mocked.basePath = "";
  });

  afterEach(() => {
    host.__weaverNavigationGuard = previousGuard;
  });

  it("keeps the editor when discard is declined, while completing creation", () => {
    const guard = vi.fn(() => false);
    host.__weaverNavigationGuard = guard;
    const onOpenChange = vi.fn();
    renderToStaticMarkup(<CreateProjectDialog onOpenChange={onOpenChange} />);

    mocked.onSuccess!({ id: "created-project" });

    expect(guard).toHaveBeenCalledWith("/projects/created-project/settings");
    expect(mocked.push).not.toHaveBeenCalled();
    expect(mocked.invalidate).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each(["", "/weaver"])(
    "checks the browser destination and navigates after confirmation with base path %s",
    (basePath) => {
      mocked.basePath = basePath;
      const guard = vi.fn(() => true);
      host.__weaverNavigationGuard = guard;
      renderToStaticMarkup(<CreateProjectDialog />);

      mocked.onSuccess!({ id: "created-project" });

      expect(guard).toHaveBeenCalledWith(
        `${basePath}/projects/created-project/settings`,
      );
      expect(mocked.push).toHaveBeenCalledExactlyOnceWith(
        "/projects/created-project/settings",
      );
    },
  );

  it("opens the new project when no editor guard is mounted", () => {
    host.__weaverNavigationGuard = undefined;
    renderToStaticMarkup(<CreateProjectDialog />);
    mocked.onSuccess!({ id: "created-project" });
    expect(mocked.push).toHaveBeenCalledExactlyOnceWith(
      "/projects/created-project/settings",
    );
  });
});
