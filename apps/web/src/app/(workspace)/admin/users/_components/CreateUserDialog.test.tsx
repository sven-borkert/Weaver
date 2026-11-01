import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({
  capturedOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ user: { list: { invalidate: vi.fn() } } }),
    user: {
      create: {
        useMutation: (options: Record<string, unknown>) => {
          mutation.capturedOptions = options;
          return { isPending: false, mutate: vi.fn(), reset: vi.fn() };
        },
      },
    },
  },
}));

import { CreateUserDialog } from "./CreateUserDialog";

describe("CreateUserDialog", () => {
  it("sets gcTime: 0 on the create mutation so the plaintext password does not linger in the query cache", () => {
    renderToStaticMarkup(<CreateUserDialog />);

    // Regression guard: without gcTime: 0, TanStack Query's default 5-minute
    // gcTime leaves the mutation (and its plaintext password result) in the
    // QueryClient's mutation cache — reachable via getMutationCache(),
    // useMutationState(), or the React Query Devtools — for up to five
    // minutes after the reveal dialog closes.
    expect(mutation.capturedOptions?.gcTime).toBe(0);
  });
});
