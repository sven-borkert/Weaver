import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "~/components/ui/tooltip";

type QueryState<T> = {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
};

type BreadcrumbMocks = {
  pathname: string;
  search: string;
  params: {
    projectId?: string;
    documentId?: string;
    tableId?: string;
    conversationId?: string;
    fileId?: string;
    userId?: string;
    adminProjectId?: string;
  };
  projectQuery: QueryState<{ name: string }>;
  examQuery: QueryState<{ title: string }>;
  documentQuery: QueryState<{ title: string; path: string }>;
  tableQuery: QueryState<{ title: string; path?: string }>;
  conversation: QueryState<{ title: string }>;
  importFile: QueryState<{ projectId: string; fileName: string }>;
  userDetail: QueryState<{ name: string }>;
  tree: QueryState<{
    folders: string[];
    folderNames?: Record<string, string>;
    documents: Array<{
      id: string;
      title: string;
      path: string;
      lastEditedAt: Date;
      lastEditedBy: null;
      index: {
        keyword: "unavailable";
        semantic: "unavailable";
        graph: "unavailable";
        summary: null;
      };
    }>;
  }>;
  landing: {
    data: { projectId: string | null } | undefined;
  };
};

const mocked = vi.hoisted((): BreadcrumbMocks => ({
  examQuery: { data: undefined, error: undefined, isLoading: false },
  pathname: "/projects/project-1/tables/table-1",
  search: "",
  params: {
    projectId: "project-1",
    tableId: "table-1",
  },
  projectQuery: {
    data: { name: "Classified project" },
    error: undefined,
    isLoading: false,
  },
  documentQuery: {
    data: undefined,
    error: undefined,
    isLoading: false,
  },
  tableQuery: {
    data: { title: "Classified table" },
    error: undefined,
    isLoading: false,
  },
  conversation: {
    data: undefined,
    error: undefined,
    isLoading: false,
  },
  importFile: {
    data: undefined,
    error: undefined,
    isLoading: false,
  },
  userDetail: {
    data: undefined,
    error: undefined,
    isLoading: false,
  },
  tree: {
    data: undefined,
    error: undefined,
    isLoading: false,
  },
  landing: {
    data: undefined,
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => mocked.params,
  usePathname: () => mocked.pathname,
  useSearchParams: () => new URLSearchParams(mocked.search),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    account: { landingProject: { useQuery: () => mocked.landing } },
    project: { get: { useQuery: () => mocked.projectQuery } },
    exam: { get: { useQuery: () => mocked.examQuery } },
    document: { get: { useQuery: () => mocked.documentQuery } },
    table: { get: { useQuery: () => mocked.tableQuery } },
    assistant: { getConversation: { useQuery: () => mocked.conversation } },
    ingestion: { getFile: { useQuery: () => mocked.importFile } },
    user: { get: { useQuery: () => mocked.userDetail } },
    folder: { tree: { useQuery: () => mocked.tree } },
    tableFolder: { tree: { useQuery: () => mocked.tree } },
  },
}));

vi.mock("./CopyLocationButton", () => ({
  CopyLocationButton: ({
    text,
    label,
  }: {
    text: string | null;
    label: string;
  }) => (
    <button
      type="button"
      aria-label={label}
      data-location={text ?? undefined}
    />
  ),
}));

import { WorkspaceBreadcrumbs } from "./WorkspaceBreadcrumbs";

function renderBreadcrumbs() {
  return renderToStaticMarkup(
    <TooltipProvider>
      <WorkspaceBreadcrumbs />
    </TooltipProvider>,
  );
}

describe("WorkspaceBreadcrumbs", () => {
  beforeEach(() => {
    mocked.pathname = "/projects/project-1/tables/table-1";
    mocked.search = "";
    mocked.params = {
      projectId: "project-1",
      tableId: "table-1",
    };
    mocked.projectQuery.data = { name: "Classified project" };
    mocked.projectQuery.error = undefined;
    mocked.projectQuery.isLoading = false;
    mocked.documentQuery.data = undefined;
    mocked.documentQuery.error = undefined;
    mocked.documentQuery.isLoading = false;
    mocked.tableQuery.data = { title: "Classified table" };
    mocked.tableQuery.error = undefined;
    mocked.tableQuery.isLoading = false;
    mocked.conversation.data = undefined;
    mocked.conversation.error = undefined;
    mocked.conversation.isLoading = false;
    mocked.importFile.data = undefined;
    mocked.importFile.error = undefined;
    mocked.importFile.isLoading = false;
    mocked.userDetail.data = undefined;
    mocked.userDetail.error = undefined;
    mocked.userDetail.isLoading = false;
    mocked.tree.data = undefined;
    mocked.tree.error = undefined;
    mocked.tree.isLoading = false;
    mocked.landing.data = undefined;
  });

  it("renders the active project and Graph for the graph route", () => {
    mocked.pathname = "/projects/project-1/graph";
    mocked.params = { projectId: "project-1" };

    const html = renderBreadcrumbs();

    expect(html).toContain('href="/projects/project-1"');
    expect(html).toContain("Graph");
    expect(html).not.toContain("Documents");
    expect(html).not.toContain("Tables");
  });

  it("renders the active project and Tasks for the tasks route", () => {
    mocked.pathname = "/projects/project-1/tasks";
    mocked.params = { projectId: "project-1" };

    const html = renderBreadcrumbs();

    expect(html).not.toContain('href="/projects/project-1/tasks"');
    expect(html).toContain('href="/projects/project-1"');
    expect(html).toContain("Tasks");
    expect(html).not.toContain("Graph");
    expect(html).not.toContain("Documents");
  });

  it("links Tasks and appends Task on the task detail route", () => {
    mocked.pathname =
      "/projects/project-1/tasks/11111111-1111-4111-8111-111111111111";
    mocked.params = { projectId: "project-1" };

    const html = renderBreadcrumbs();

    expect(html).toContain('href="/projects/project-1/tasks"');
    expect(html).toContain("Tasks");
    expect(html).toContain("Task<");
  });

  it("renders the active project and Imports for the imports route", () => {
    mocked.pathname = "/projects/project-1/imports";
    mocked.params = { projectId: "project-1" };

    const html = renderBreadcrumbs();

    expect(html).not.toContain('href="/projects/project-1/imports"');
    expect(html).toContain('href="/projects/project-1"');
    expect(html).toContain("Imports");
    expect(html).not.toContain("Graph");
    expect(html).not.toContain("Documents");
    expect(html).not.toContain("Tables");
  });

  it("renders the import file breadcrumb only when it belongs to the route project", () => {
    mocked.pathname =
      "/projects/project-1/imports/11111111-1111-4111-8111-111111111111";
    mocked.params = {
      projectId: "project-1",
      fileId: "11111111-1111-4111-8111-111111111111",
    };
    mocked.importFile.data = { projectId: "project-1", fileName: "notes.md" };
    expect(renderBreadcrumbs()).toContain("notes.md");
    mocked.importFile.data = { projectId: "other", fileName: "secret.md" };
    const html = renderBreadcrumbs();
    expect(html).toContain("Review");
    expect(html).not.toContain("secret.md");
  });

  it.each(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"])(
    "hides a cached import filename after %s",
    (code) => {
      mocked.pathname =
        "/projects/project-1/imports/11111111-1111-4111-8111-111111111111";
      mocked.params = {
        projectId: "project-1",
        fileId: "11111111-1111-4111-8111-111111111111",
      };
      mocked.importFile.data = {
        projectId: "project-1",
        fileName: "cached-private.md",
      };
      mocked.importFile.error = { data: { code } };
      const html = renderBreadcrumbs();
      expect(html).toContain('href="/projects/project-1"');
      expect(html).toContain("Review");
      expect(html).not.toContain("cached-private.md");
    },
  );

  it("renders the static Account and Tasks trail for the account tasks route", () => {
    mocked.pathname = "/account/tasks";
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).toContain("Account");
    expect(html).toContain("Tasks");
    expect(html).not.toContain("Classified project");
  });

  it("renders the static Account and Remote instances trail for the account remote-instances route", () => {
    mocked.pathname = "/account/remote-instances";
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).toContain("Account");
    expect(html).toContain("Remote instances");
    expect(html).not.toContain("Classified project");
  });

  it.each([
    ["ai", "AI"],
    ["remote-instances", "Remote instances"],
    ["oidc", "OIDC"],
  ])("renders Administration / Settings / %s", (tab, title) => {
    mocked.pathname = `/admin/settings/${tab}`;
    mocked.params = {};
    const html = renderBreadcrumbs();
    expect(html).toContain("Administration");
    expect(html).toContain("Settings");
    expect(html).toContain(title);
    expect(html).not.toContain("Classified project");
  });

  it("renders the static Administration and AI trail for the admin route", () => {
    mocked.pathname = "/admin/ai";
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).toContain("Administration");
    expect(html).toContain("AI");
    expect(html).not.toContain("Classified project");
  });

  it.each([
    ["/reviews", "Open"],
    ["/reviews/recent", "Recently reviewed"],
  ])("renders a static Reviews trail for %s", (pathname, leaf) => {
    mocked.pathname = pathname;
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).toContain("Reviews");
    expect(html).toContain(leaf);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).not.toContain("Classified project");
  });

  it("renders the static Account and MCP connections trail", () => {
    mocked.pathname = "/account/connections";
    const html = renderBreadcrumbs();
    expect(html).toContain("Account");
    expect(html).toContain("MCP connections");
  });

  it("renders the static Administration and Remote instances trail", () => {
    mocked.pathname = "/admin/remote-instances";
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).toContain("Administration");
    expect(html).toContain("Remote instances");
    expect(html).not.toContain("Classified project");
  });

  it("renders the static Administration and Diagnostics trail for the diagnostics route", () => {
    mocked.pathname = "/admin/diagnostics";
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).toContain("Administration");
    expect(html).toContain("Diagnostics");
    expect(html).not.toContain("Classified project");
  });

  it("renders the static Administration and Users trail for the users route", () => {
    mocked.pathname = "/admin/users";
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).toContain("Administration");
    expect(html).toContain("Users");
    expect(html).not.toContain("Classified project");
  });

  it("renders the Administration and Projects trail for the projects route", () => {
    mocked.pathname = "/admin/projects";
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).toContain("Administration");
    expect(html).toContain("Projects");
    expect(html).not.toContain("Classified project");
  });

  it("links back to Projects from the admin project detail route", () => {
    mocked.pathname = "/admin/projects/project-9";
    mocked.params = { adminProjectId: "project-9" };

    const html = renderBreadcrumbs();

    expect(html).toContain('href="/admin/projects"');
    expect(html).toContain("Project details");
    expect(html).not.toContain("Classified project");
  });

  it("renders Administration / Users / <name> for the user detail route", () => {
    mocked.pathname = "/admin/users/user-1";
    mocked.params = { userId: "user-1" };
    mocked.userDetail.data = { name: "Classified user" };

    const html = renderBreadcrumbs();

    expect(html).toContain("Administration");
    expect(html).toContain('href="/admin/users"');
    expect(html).toContain("Classified user");
  });

  it("falls back to a nonsensitive label while the user detail query loads", () => {
    mocked.pathname = "/admin/users/user-1";
    mocked.params = { userId: "user-1" };
    mocked.userDetail.isLoading = true;

    const html = renderBreadcrumbs();

    expect(html).toContain("Administration");
    expect(html).not.toContain("Classified user");
  });

  it.each(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"])(
    "hides a cached user name after %s on the user detail route",
    (code) => {
      mocked.pathname = "/admin/users/user-1";
      mocked.params = { userId: "user-1" };
      mocked.userDetail.data = { name: "Classified user" };
      mocked.userDetail.error = { data: { code } };

      const html = renderBreadcrumbs();

      expect(html).not.toContain("Classified user");
      expect(html).toContain("User");
    },
  );

  it.each(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"])(
    "hides cached project and table titles after a %s refresh",
    (code) => {
      mocked.projectQuery.error = { data: { code } };
      mocked.tableQuery.error = { data: { code } };

      const html = renderBreadcrumbs();

      expect(html).not.toContain("Classified project");
      expect(html).not.toContain("Classified table");
      expect(html).not.toContain('href="/projects/project-1"');
      expect(html).not.toContain("Tables");
    },
  );

  it("retains cached titles after a transient refresh failure", () => {
    mocked.projectQuery.error = {
      data: { code: "INTERNAL_SERVER_ERROR" },
    };
    mocked.tableQuery.error = {
      data: { code: "INTERNAL_SERVER_ERROR" },
    };

    const html = renderBreadcrumbs();

    expect(html).toContain('href="/projects/project-1"');
    expect(html).toContain("Classified table");
  });

  it("renders Assistant / <title> on the conversation route and hides the title on NOT_FOUND", () => {
    mocked.pathname = "/assistant/11111111-1111-4111-8111-111111111111";
    mocked.params = { conversationId: "11111111-1111-4111-8111-111111111111" };
    mocked.conversation = {
      data: { title: "Deploy questions" },
      error: undefined,
      isLoading: false,
    };
    expect(renderBreadcrumbs()).toContain("Deploy questions");
    mocked.conversation = {
      data: { title: "Deploy questions" },
      error: { data: { code: "NOT_FOUND" } },
      isLoading: false,
    };
    const html = renderBreadcrumbs();
    expect(html).toContain("Assistant");
    expect(html).not.toContain("Deploy questions");
  });

  it("does not label the root redirect route as Home", () => {
    mocked.pathname = "/";
    mocked.params = {};

    const html = renderBreadcrumbs();

    expect(html).not.toContain(">Home<");
  });

  it("starts every project trail with a link to the project", () => {
    const html = renderBreadcrumbs();
    expect(html).toContain('href="/projects/project-1"');
    expect(html).toContain("Classified table");
  });

  it("labels the project Activity route", () => {
    mocked.pathname = "/projects/project-1/activity";
    mocked.params = { projectId: "project-1" };
    const html = renderBreadcrumbs();
    expect(html).toContain("Activity");
    expect(html).not.toContain("Documents");
  });

  it("starts admin routes at Administration, without a project crumb", () => {
    mocked.pathname = "/admin/ai";
    mocked.params = {};
    mocked.landing.data = { projectId: "project-1" };
    const html = renderBreadcrumbs();
    expect(html).toContain("Administration");
    expect(html).not.toContain('href="/projects/project-1"');
    expect(html).not.toContain('aria-label="Switch project"');
  });

  it("renders folder crumbs with links and sibling menus on the folder route", () => {
    mocked.pathname = "/projects/project-1/documents";
    mocked.params = { projectId: "project-1" };
    mocked.search = "folder=guides/setup";
    mocked.tree.data = {
      folders: ["guides", "guides/setup"],
      documents: [
        {
          id: "d1",
          title: "Installing",
          path: "guides/setup/installing.md",
          lastEditedAt: new Date(),
          lastEditedBy: null,
          index: {
            keyword: "unavailable",
            semantic: "unavailable",
            graph: "unavailable",
            summary: null,
          },
        },
      ],
    };
    const html = renderBreadcrumbs();
    expect(html).toContain('href="/projects/project-1/documents"');
    expect(html).toContain(
      'href="/projects/project-1/documents?folder=guides"',
    );
    expect(html).toContain('aria-label="Show contents of Documents"');
    expect(html).toContain('aria-label="Show contents of guides"');
    expect(html).toMatch(/aria-current="page"[^>]*>setup</);
  });

  it("falls back to the root Documents crumb for a malformed folder query", () => {
    mocked.pathname = "/projects/project-1/documents";
    mocked.params = { projectId: "project-1" };
    mocked.search = "folder=Guides";
    const html = renderBreadcrumbs();
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(">Documents<");
    expect(html).not.toContain("Guides");
  });

  it("copies the document location once its folder names are loaded", () => {
    mocked.pathname = "/projects/project-1/documents/d1";
    mocked.params = { projectId: "project-1", documentId: "d1" };
    mocked.documentQuery.data = {
      title: "Installing",
      path: "guides/setup/installing.md",
    };
    mocked.tree.data = {
      folders: [],
      folderNames: { guides: "Guides", "guides/setup": "Setup" },
      documents: [],
    };
    const html = renderBreadcrumbs();
    expect(html).toContain('aria-label="Copy document location"');
    expect(html).toContain(
      'data-location="Project: Classified project\nFolder: Guides / Setup\nDocument: Installing\nProject ID: project-1\nDocument ID: d1"',
    );
  });

  it("holds the document location back until folder names are loaded", () => {
    mocked.pathname = "/projects/project-1/documents/d1";
    mocked.params = { projectId: "project-1", documentId: "d1" };
    mocked.documentQuery.data = {
      title: "Installing",
      path: "guides/setup/installing.md",
    };
    const html = renderBreadcrumbs();
    expect(html).toContain('aria-label="Copy document location"');
    expect(html).not.toContain("data-location");
  });

  it("copies the table location with its folder names", () => {
    mocked.tableQuery.data = {
      title: "Budget",
      path: "tables/finance/q1/budget.table",
    };
    mocked.tree.data = {
      folders: [],
      folderNames: { finance: "Finance", "finance/q1": "Q1" },
      documents: [],
    };
    const html = renderBreadcrumbs();
    expect(html).toContain('aria-label="Copy table location"');
    expect(html).toContain(
      'data-location="Project: Classified project\nFolder: Finance / Q1\nTable: Budget\nProject ID: project-1\nTable ID: table-1"',
    );
  });

  it("renders the document's folder path before its title", () => {
    mocked.pathname = "/projects/project-1/documents/d1";
    mocked.params = { projectId: "project-1", documentId: "d1" };
    mocked.documentQuery.data = {
      title: "Installing",
      path: "guides/setup/installing.md",
    };
    const html = renderBreadcrumbs();
    expect(html).toContain(
      'href="/projects/project-1/documents?folder=guides%2Fsetup"',
    );
    expect(html).toContain("Installing");
  });

  it("renders folder crumbs for a table nested under folders", () => {
    mocked.pathname = "/projects/project-1/tables/table-1";
    mocked.params = { projectId: "project-1", tableId: "table-1" };
    mocked.tableQuery.data = {
      title: "Budget",
      path: "tables/finance/q1/budget.table",
    };

    const html = renderBreadcrumbs();

    expect(html).toContain('href="/projects/project-1/tables"');
    expect(html).toContain('href="/projects/project-1/tables?folder=finance"');
    expect(html).toContain(
      'href="/projects/project-1/tables?folder=finance%2Fq1"',
    );
    expect(html).toContain("Budget");
  });
});

describe("exam breadcrumbs", () => {
  beforeEach(() => {
    mocked.projectQuery = {
      data: { name: "Training project" },
      error: undefined,
      isLoading: false,
    };
    mocked.params = { projectId: "project-1" };
    mocked.examQuery = {
      data: { title: "Safety basics" },
      error: undefined,
      isLoading: false,
    };
  });
  it("links an attempt back to Exams", () => {
    mocked.pathname = "/projects/project-1/exams/attempts/attempt-1";
    const html = renderBreadcrumbs();
    expect(html).toContain('href="/projects/project-1/exams"');
    expect(html).toContain("Attempt");
  });
  it("shows the definition title and hides it after access is lost", () => {
    mocked.pathname = "/projects/project-1/exams/exam-1";
    expect(renderBreadcrumbs()).toContain("Safety basics");
    mocked.examQuery.error = { data: { code: "FORBIDDEN" } };
    expect(renderBreadcrumbs()).not.toContain("Safety basics");
  });
});
