import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import type { ExternalApprovalView } from "@weaver/core/externalMcp/types";
const mock = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  settled: null as null | (() => void),
}));
const approval: ExternalApprovalView = {
  id: "a",
  callId: "c",
  connectionName: "Service",
  toolName: "Update",
  effect: "write",
  arguments: { nested: { complete: "x".repeat(9000) } },
  expiresAt: "2026-09-09T12:00:00Z",
  status: "pending",
};
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      externalMcp: {
        getApproval: { invalidate: mock.invalidate },
        listApprovals: { invalidate: mock.invalidate },
      },
      assistant: {
        getConversation: { invalidate: mock.invalidate },
        getConversationStatus: { invalidate: mock.invalidate },
      },
    }),
    externalMcp: {
      getApproval: { useQuery: () => ({ data: approval, isFetching: false }) },
      decideApproval: {
        useMutation: (options: { onSettled: () => void }) => {
          mock.settled = options.onSettled;
          return { mutate: mock.mutate, isPending: false };
        },
      },
    },
  },
}));
import {
  ExternalApproval,
  ExternalToolApprovalCard,
} from "./ExternalToolApprovalCard";
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
it("renders complete arguments and settled statuses without active decisions", () => {
  const html = renderToStaticMarkup(
    <ExternalToolApprovalCard approval={approval} onDecide={vi.fn()} pending />,
  );
  expect(html).toContain("x".repeat(9000));
  expect(html).toContain("Writes to the external service");
  expect(html).toMatch(/disabled=""/);
  for (const status of [
    "approved",
    "denied",
    "invalidated",
    "expired",
    "settled",
  ] as const) {
    expect(
      renderToStaticMarkup(
        <ExternalToolApprovalCard
          approval={{ ...approval, status, arguments: null }}
          onDecide={vi.fn()}
          pending={false}
        />,
      ),
    ).not.toContain(">Approve<");
  }
});
it("restores owner detail by ID and locks duplicate mounted clicks; invalidates decisions", async () => {
  let renderer: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <ExternalApproval id="a" runId="run" conversationId="conversation" />,
    );
  });
  const button = renderer!.root
    .findAllByType("button")
    .find((node) => node.children.includes("Approve"))!;
  await act(() => {
    (button.props as { onClick: () => void }).onClick();
    (button.props as { onClick: () => void }).onClick();
  });
  expect(mock.mutate).toHaveBeenCalledTimes(1);
  expect(mock.mutate).toHaveBeenCalledWith({ id: "a", decision: "approve" });
  mock.settled!();
  expect(mock.invalidate).toHaveBeenCalledWith({ id: "a" });
  expect(mock.invalidate).toHaveBeenCalledWith({ runId: "run" });
  expect(mock.invalidate).toHaveBeenCalledWith({
    conversationId: "conversation",
  });
  await act(() => renderer!.unmount());
});
