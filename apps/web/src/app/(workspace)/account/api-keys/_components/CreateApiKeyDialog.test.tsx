import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({
  capturedOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ apiKey: { list: { invalidate: vi.fn() } } }),
    apiKey: {
      create: {
        useMutation: (options: Record<string, unknown>) => {
          mutation.capturedOptions = options;
          return { isPending: false, mutate: vi.fn(), reset: vi.fn() };
        },
      },
    },
  },
}));

import { CreateApiKeyDialog } from "./CreateApiKeyDialog";

describe("CreateApiKeyDialog", () => {
  it("offers both MCP connection capabilities", () => {
    const html = renderToStaticMarkup(
      <CreateApiKeyDialog isAdmin={false} projects={[]} />,
    );
    expect(html).toContain("Use your MCP connections");
    expect(html).toContain("Manage your MCP connections");
    expect(html).not.toContain("service account");
  });

  it("sets gcTime: 0 on the create mutation so the one-time secret does not linger in the query cache", () => {
    renderToStaticMarkup(<CreateApiKeyDialog isAdmin={false} projects={[]} />);

    // Regression guard: without gcTime: 0, TanStack Query's default 5-minute
    // gcTime leaves the mutation (and its plaintext secret result) in the
    // QueryClient's mutation cache — reachable via getMutationCache(),
    // useMutationState(), or the React Query Devtools — for up to five
    // minutes after the dialog closes. reset() on close only detaches the
    // observer and schedules that GC; the two work as a pair.
    expect(mutation.capturedOptions?.gcTime).toBe(0);
  });

  it("offers the external feed capability to every user", () => {
    const html = renderToStaticMarkup(
      <CreateApiKeyDialog isAdmin={false} projects={[]} />,
    );

    expect(html).toContain("Submit files to Imports from external systems");
    expect(html).toContain(
      "Lets an external system push files into Imports for your review.",
    );
  });

  it("offers system administration only to Admins", () => {
    const adminHtml = renderToStaticMarkup(
      <CreateApiKeyDialog isAdmin projects={[]} />,
    );
    const userHtml = renderToStaticMarkup(
      <CreateApiKeyDialog isAdmin={false} projects={[]} />,
    );

    expect(adminHtml).toContain("System administration");
    expect(adminHtml).toContain("Only while you remain an Admin.");
    expect(userHtml).not.toContain("System administration");
  });
});
