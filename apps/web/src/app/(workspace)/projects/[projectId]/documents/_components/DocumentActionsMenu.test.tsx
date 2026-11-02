import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStatusProvider } from "~/app/(workspace)/_components/RuntimeStatusContext";

const mocked = vi.hoisted(
  (): {
    permissions:
      { canMarkReviewed: boolean; canEditReview: boolean } | undefined;
    remotes: unknown[] | undefined;
    role: string;
  } => ({ permissions: undefined, remotes: [], role: "Editor" }),
);

vi.mock("~/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <div data-menu-item data-disabled={disabled ? "true" : undefined}>
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("./MarkReviewedDialog", () => ({ MarkReviewedDialog: () => null }));
vi.mock("./PropertiesDialog", () => ({ PropertiesDialog: () => null }));
vi.mock("./ReviewSettingsDialog", () => ({
  ReviewSettingsDialog: () => null,
}));
vi.mock("../../_components/SendToRemoteDialog", () => ({
  SendToRemoteDialog: () => null,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    document: {
      reviewPermissions: { useQuery: () => ({ data: mocked.permissions }) },
    },
    project: { get: { useQuery: () => ({ data: { myRole: mocked.role } }) } },
    remoteInstance: {
      listForUser: { useQuery: () => ({ data: mocked.remotes }) },
    },
  },
}));

import { DocumentActionsMenu } from "./DocumentActionsMenu";

const document = { id: "d-1", title: "Plan", kind: "markdown" } as never;
const pythonDocument = { id: "d-2", title: "Script", kind: "python" } as never;
const render = (dirty = false, doc = document) =>
  renderToStaticMarkup(
    <DocumentActionsMenu
      projectId="p-1"
      document={doc}
      baseCommitSha={"a".repeat(40)}
      dirty={dirty}
    />,
  );
const disabledItem = (html: string, label: string) =>
  new RegExp(`data-disabled="true">(?:(?!data-menu-item).)*${label}`).test(
    html,
  );

beforeEach(() => {
  mocked.permissions = undefined;
  mocked.remotes = [];
  mocked.role = "Editor";
});

describe("DocumentActionsMenu", () => {
  it("offers graph, PDF and ZIP to every reader", () => {
    const html = render();
    expect(html).toContain('aria-label="Document actions"');
    expect(html).toContain('href="/projects/p-1/graph?document=d-1"');
    expect(html).toContain('href="/api/documents/d-1/pdf?projectId=p-1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="/api/documents/d-1/archive?projectId=p-1"');
    expect(html).toContain("download");
    expect(html).not.toContain("Mark as reviewed");
    expect(html).not.toContain("Review settings…");
    expect(html).not.toContain("Send to another Weaver…");
    expect(html).not.toContain('data-disabled="true"');
  });

  it("shows the review actions only with their permissions", () => {
    mocked.permissions = { canMarkReviewed: true, canEditReview: false };
    expect(render()).toContain("Mark as reviewed");
    expect(render()).not.toContain("Review settings…");
    mocked.permissions = { canMarkReviewed: false, canEditReview: true };
    expect(render()).not.toContain("Mark as reviewed");
    expect(render()).toContain("Review settings…");
  });

  it("disables the review actions with a hint while the editor is dirty", () => {
    mocked.permissions = { canMarkReviewed: true, canEditReview: true };
    const html = render(true);
    expect(disabledItem(html, "Mark as reviewed")).toBe(true);
    expect(disabledItem(html, "Review settings…")).toBe(true);
    expect(html).toContain("Save or discard your changes first");
    expect(html).toContain("Exports the saved version");
    expect(html).toContain("Downloads the saved version");
    expect(html).not.toContain("Explore graph");
  });

  it("offers properties to editors only and disables them while dirty", () => {
    expect(render()).toContain("Properties…");
    expect(disabledItem(render(true), "Properties…")).toBe(true);
    mocked.role = "Viewer";
    expect(render()).not.toContain("Properties…");
  });

  it("offers sending only when a remote instance is registered", () => {
    mocked.remotes = [{ id: "r-1" }];
    expect(render()).toContain("Send to another Weaver…");
    expect(render(true)).toContain("Sends the saved version");
  });

  it("disables PDF export and sending for Python files", () => {
    mocked.remotes = [{ id: "r-1" }];
    const html = render(false, pythonDocument);
    expect(disabledItem(html, "Export as PDF")).toBe(true);
    expect(disabledItem(html, "Send to another Weaver…")).toBe(true);
    expect(html).toContain("Not available for Python files");
    expect(html).toContain("Download as ZIP<");
    expect(html).not.toContain("with images");
  });

  it("disables PDF export with an explanation when the server has no Chromium", () => {
    const html = renderToStaticMarkup(
      <RuntimeStatusProvider
        value={{ pdf: { status: "missing", reason: "no chromium" } }}
      >
        <DocumentActionsMenu
          projectId="p-1"
          document={document}
          baseCommitSha={"a".repeat(40)}
        />
      </RuntimeStatusProvider>,
    );
    expect(disabledItem(html, "Export as PDF")).toBe(true);
    expect(html).toContain("PDF export is unavailable on this server");
  });
});
