import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MachineKeySecretDialog } from "./MachineKeySecretDialog";

const SECRET = "wvr_project_11111111-1111-4111-8111-111111111111.once";
const grants = [
  {
    kind: "table" as const,
    targetId: "22222222-2222-4222-8222-222222222222",
    root: false,
    actions: ["create" as const],
    available: true,
    label: "Audit results",
    location: "tables/audit/audit-results",
    columns: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Account",
        type: "text" as const,
      },
    ],
  },
];

describe("one-time project key secret", () => {
  it("shows the secret once, outside the examples, with column-specific rows", () => {
    const html = renderToStaticMarkup(
      <MachineKeySecretDialog
        secret={SECRET}
        projectId="project"
        baseUrl="https://weaver.example/weaver"
        grants={grants}
        refreshFailed={false}
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html.split(SECRET)).toHaveLength(2);
    expect(html).toContain("33333333-3333-4333-8333-333333333333");
    expect(html).toContain("WEAVER_PROJECT_API_KEY");
    expect(html).not.toContain("Retry list refresh");
  });

  it("offers a list refresh retry after the key was accepted", () => {
    const html = renderToStaticMarkup(
      <MachineKeySecretDialog
        secret={SECRET}
        projectId="project"
        baseUrl={null}
        grants={grants}
        refreshFailed
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain(SECRET);
    expect(html).toContain("Retry list refresh");
  });
});
