import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(
  (): {
    query: { data: unknown; error: unknown; isLoading: boolean };
  } => ({
    query: { data: undefined, error: null, isLoading: false },
  }),
);

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("~/trpc/react", () => ({
  api: { project: { get: { useQuery: () => mocked.query } } },
}));
vi.mock("./_components/MachineApiKeysCard", () => ({
  MachineApiKeysCard: ({ canManage }: { canManage: boolean }) =>
    canManage ? <section data-project-api-keys /> : null,
}));
vi.mock("./_components/ProjectSettingsForm", () => ({
  ProjectSettingsForm: () => <form data-settings-form />,
}));
vi.mock("./_components/MembersSection", () => ({
  MembersSection: () => <section data-members />,
}));
vi.mock("./_components/DeleteProjectDialog", () => ({
  DeleteProjectDialog: () => null,
}));
vi.mock("./_components/DocumentReviewCard", () => ({
  DocumentReviewCard: () => <section data-document-review />,
}));
vi.mock("./_components/DocumentMaintenanceCard", () => ({
  DocumentMaintenanceCard: () => null,
}));
vi.mock("./_components/GitRemoteCard", () => ({ GitRemoteCard: () => null }));
vi.mock("./_components/KnowledgeIndexCard", () => ({
  KnowledgeIndexCard: () => null,
}));
vi.mock("./_components/TableMaintenanceCard", () => ({
  TableMaintenanceCard: () => null,
}));

import ProjectSettingsPage from "./page";

const project = {
  id: "p1",
  name: "Atlas",
  description: null,
  myRole: "Owner",
  personalOwnerId: null,
};

describe("ProjectSettingsPage", () => {
  beforeEach(() => {
    mocked.query = { data: project, error: null, isLoading: false };
  });

  it("keeps the forms mounted when a background refetch fails transiently", () => {
    mocked.query = {
      data: project,
      error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      isLoading: false,
    };
    const html = renderToStaticMarkup(<ProjectSettingsPage />);
    expect(html).toContain("data-settings-form");
    expect(html).toContain("data-members");
    expect(html).toContain("data-document-review");
    expect(html).not.toContain("Project not found");
  });

  it.each(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"])(
    "clears retained data on a %s access error",
    (code) => {
      mocked.query = {
        data: project,
        error: { data: { code } },
        isLoading: false,
      };
      const html = renderToStaticMarkup(<ProjectSettingsPage />);
      expect(html).toContain("Project not found");
      expect(html).not.toContain("data-settings-form");
      expect(html).not.toContain("Atlas");
    },
  );

  it.each([
    ["Owner", true],
    ["Maintainer", true],
    ["Editor", false],
    ["Viewer", false],
  ])("offers project API keys to %s: %s", (myRole, visible) => {
    mocked.query = {
      data: { ...project, myRole },
      error: null,
      isLoading: false,
    };
    expect(
      renderToStaticMarkup(<ProjectSettingsPage />).includes(
        "data-project-api-keys",
      ),
    ).toBe(visible);
  });

  it("shows the skeleton while loading and not-found without data", () => {
    mocked.query = { data: undefined, error: null, isLoading: true };
    expect(renderToStaticMarkup(<ProjectSettingsPage />)).not.toContain(
      "Project not found",
    );
    mocked.query = {
      data: undefined,
      error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      isLoading: false,
    };
    expect(renderToStaticMarkup(<ProjectSettingsPage />)).toContain(
      "Project not found",
    );
  });
});
