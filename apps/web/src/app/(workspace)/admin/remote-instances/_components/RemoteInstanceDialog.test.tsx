import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));

// The real Dialog renders through a Radix Portal, which only mounts client-side
// (no `document` in this node test environment) — mock it so content renders inline.
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
    useUtils: () => ({ remoteInstance: { invalidate: vi.fn() } }),
    remoteInstance: {
      create: {
        useMutation: () => ({ mutate: mocked.create, isPending: false }),
      },
      update: {
        useMutation: () => ({ mutate: mocked.update, isPending: false }),
      },
    },
  },
}));

import { RemoteInstanceDialog } from "./RemoteInstanceDialog";

const refs = {
  returnFocusRef: { current: null },
  fallbackFocusRef: { current: null },
};

describe("RemoteInstanceDialog", () => {
  it("renders the add form with name, base URL and enabled fields", () => {
    const html = renderToStaticMarkup(
      <RemoteInstanceDialog open onOpenChange={() => undefined} {...refs} />,
    );
    expect(html).toContain("Add remote instance");
    expect(html).toContain('name="name"');
    expect(html).toContain('name="baseUrl"');
    expect(html).toContain("https://");
    expect(html).toContain('type="checkbox"');
    expect(
      /<label[^>]*>[^<]*<input[^>]*type="checkbox"[^>]*>[^<]*Enabled<\/label>/.exec(
        html,
      ),
    ).not.toBeNull();
    expect(/<label[^>]*>(?:(?!<\/label>).)*<label/s.exec(html)).toBeNull();
  });

  it("renders the edit form with the remote's values", () => {
    const remote = {
      id: "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c",
      name: "Second",
      baseUrl: "https://b.example.com/weaver",
      enabled: false,
      revision: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastCheckedAt: null,
      checkStatus: null,
      checkErrorSummary: null,
    };
    const html = renderToStaticMarkup(
      <RemoteInstanceDialog
        open
        onOpenChange={() => undefined}
        remote={remote}
        {...refs}
      />,
    );
    expect(html).toContain("Edit remote instance");
    expect(html).toContain('value="Second"');
    expect(html).toContain('value="https://b.example.com/weaver"');
    expect(html).toContain("Changing the base URL disconnects every user");
  });
});
