import { QueryClient } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked: {
  params: { projectId?: string };
  calls: Array<{ projectId: string }>;
  onSuccess?: () => void;
  invalidateLandingProject: () => Promise<void>;
} = vi.hoisted(() => ({
  params: {},
  calls: [],
  invalidateLandingProject: async () => undefined,
}));

vi.mock("next/navigation", () => ({ useParams: () => mocked.params }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      account: {
        landingProject: { invalidate: mocked.invalidateLandingProject },
      },
    }),
    account: {
      recordLastOpenedProject: {
        useMutation: (options: { onSuccess: () => void }) => {
          mocked.onSuccess = options.onSuccess;
          return {
            mutate: (input: { projectId: string }) => mocked.calls.push(input),
          };
        },
      },
    },
  },
}));

import { LastOpenedProjectRecorder } from "./LastOpenedProjectRecorder";

const landingProjectKey = ["account", "landingProject"] as const;
let queryClient: QueryClient;

const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("LastOpenedProjectRecorder", () => {
  beforeEach(() => {
    mocked.params = {};
    mocked.calls = [];
    mocked.onSuccess = undefined;
    queryClient = new QueryClient();
    mocked.invalidateLandingProject = () =>
      queryClient.invalidateQueries({ queryKey: landingProjectKey });
  });

  afterEach(() => queryClient.clear());

  it("records a project route once, even across re-renders", async () => {
    mocked.params = { projectId: PROJECT };
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<LastOpenedProjectRecorder />);
    });
    await act(async () => {
      renderer!.update(<LastOpenedProjectRecorder />);
    });
    expect(mocked.calls).toEqual([{ projectId: PROJECT }]);
  });

  it("invalidates the cached landing project only after the route is recorded successfully", async () => {
    mocked.params = { projectId: PROJECT };
    queryClient.setQueryData(landingProjectKey, {
      projectId: "previous-project",
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<LastOpenedProjectRecorder />);
    });
    expect(queryClient.getQueryState(landingProjectKey)?.isInvalidated).toBe(
      false,
    );
    expect(mocked.calls).toEqual([{ projectId: PROJECT }]);
    await act(async () => {
      mocked.onSuccess!();
    });
    expect(queryClient.getQueryState(landingProjectKey)?.isInvalidated).toBe(
      true,
    );
    await act(async () => {
      renderer.unmount();
    });
  });

  it("ignores routes without a valid project id", async () => {
    mocked.params = { projectId: "not-a-uuid" };
    await act(async () => {
      create(<LastOpenedProjectRecorder />);
    });
    expect(mocked.calls).toEqual([]);
  });
});
