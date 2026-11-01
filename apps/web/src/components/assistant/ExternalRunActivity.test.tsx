import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import type { ExternalCallView } from "@weaver/core/externalMcp/types";
const mock = vi.hoisted(
  (): {
    calls: ExternalCallView[];
    error: unknown;
    refetch: ReturnType<typeof vi.fn>;
  } => ({ calls: [], error: null, refetch: vi.fn() }),
);
vi.mock("~/trpc/react", () => ({
  api: {
    externalMcp: {
      listCalls: {
        useQuery: () => ({
          data: { calls: mock.calls, nextAfter: null },
          error: mock.error,
          refetch: mock.refetch,
        }),
      },
    },
  },
}));
import { ExternalRunActivity } from "./ExternalRunActivity";
const call: ExternalCallView = {
  callId: "call",
  toolCallId: "toolcall",
  connectionId: "connection",
  connectionName: "First service",
  toolName: "same_name",
  status: "unknown",
  summary:
    "The remote operation may have completed. This call was not replayed automatically; check the external service before trying again.",
  error: null,
};
beforeEach(() => {
  mock.calls = [call];
  mock.error = null;
  vi.clearAllMocks();
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: clearTimeout,
  });
});
it("restores unknown outcomes across actual unmount/remount without live events", async () => {
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<ExternalRunActivity runId="run" />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "not replayed automatically",
  );
  await act(() => renderer.unmount());
  await act(() => {
    renderer = create(<ExternalRunActivity runId="run" />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "First service / same_name",
  );
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "not replayed automatically",
  );
  await act(() => renderer.unmount());
});
it("reconciles settled metadata with stale live activity and distinguishes same-named tools", async () => {
  mock.calls = [
    call,
    {
      ...call,
      callId: "second",
      toolCallId: "second",
      connectionId: "other",
      connectionName: "Second service",
      status: "completed",
      summary: "Received 42 bytes of external data.",
    },
  ];
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <ExternalRunActivity
        runId="run"
        active
        live={[
          {
            callId: "call",
            toolCallId: "toolcall",
            toolName: "same_name",
            externalStatus: "prepared",
            ok: null,
            input: null,
            summary: null,
          },
        ]}
      />,
    );
  });
  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain("First service / same_name");
  expect(output).toContain("Second service / same_name");
  expect(output).toContain("Received 42 bytes");
  expect(output).toContain("outcome unknown");
  mock.error = { data: { code: "NOT_FOUND" } };
  await act(() => renderer.update(<ExternalRunActivity runId="run" />));
  expect(JSON.stringify(renderer.toJSON())).not.toContain("First service");
  await act(() => renderer.unmount());
});
