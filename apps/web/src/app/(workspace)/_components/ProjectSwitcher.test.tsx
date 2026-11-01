import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Project = {
  id: string;
  name: string;
  myRole: "Owner" | "Maintainer" | "Editor" | "Viewer";
};

const P1 = "11111111-1111-4111-8111-111111111111";

type Mocked = {
  pathname: string;
  params: { projectId?: string };
  list: {
    data: Project[] | undefined;
    error: unknown;
    isLoading: boolean;
    refetch: () => Promise<void>;
  };
  get: {
    data: { name: string } | undefined;
    error: unknown;
    isLoading: boolean;
  };
  landing: {
    data: { projectId: string | null } | undefined;
  };
  pushed: string[];
};

const mocked = vi.hoisted((): Mocked => ({
  pathname: "/admin/ai",
  params: {},
  list: {
    data: undefined,
    error: undefined,
    isLoading: false,
    refetch: () => Promise.resolve(),
  },
  get: {
    data: undefined,
    error: undefined,
    isLoading: false,
  },
  landing: {
    data: undefined,
  },
  pushed: [],
}));

vi.mock("next/navigation", () => ({
  useParams: () => mocked.params,
  usePathname: () => mocked.pathname,
  useRouter: () => ({ push: (href: string) => mocked.pushed.push(href) }),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    account: { landingProject: { useQuery: () => mocked.landing } },
    project: {
      list: { useQuery: () => mocked.list },
      get: { useQuery: () => mocked.get },
    },
  },
}));
vi.mock("./CreateProjectDialog", () => ({
  CreateProjectDialog: () => <button>New project</button>,
}));
// Radix's dropdown Content renders through a Portal that never mounts under
// renderToStaticMarkup (no `document`), so menu items are otherwise
// invisible to a static render; unwrap them to assert on aria-current.
vi.mock("~/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect: _onSelect,
    ...rest
  }: {
    children?: ReactNode;
    onSelect?: () => void;
  } & Record<string, unknown>) => <div {...rest}>{children}</div>,
}));

import { ProjectSwitcher } from "./ProjectSwitcher";

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    mocked.pathname = "/admin/ai";
    mocked.params = {};
    mocked.list.data = undefined;
    mocked.list.error = undefined;
    mocked.list.isLoading = false;
    mocked.get.data = undefined;
    mocked.get.error = undefined;
    mocked.get.isLoading = false;
    mocked.landing.data = undefined;
    mocked.pushed = [];
  });

  it("shows the neutral label on global routes with no landing project", () => {
    const html = renderToStaticMarkup(<ProjectSwitcher />);
    expect(html).toContain('aria-label="Switch project"');
    expect(html).toContain("Projects");
  });

  it("shows the landing project name on global routes", () => {
    mocked.pathname = "/admin/ai";
    mocked.landing.data = { projectId: P1 };
    mocked.get.data = { name: "Sticky project" };
    expect(renderToStaticMarkup(<ProjectSwitcher />)).toContain(
      "Sticky project",
    );
  });

  it("shows the current project name on project routes", () => {
    mocked.pathname = "/projects/p1/tables";
    mocked.params = { projectId: P1 };
    mocked.get.data = { name: "Classified project" };
    const html = renderToStaticMarkup(<ProjectSwitcher />);
    expect(html).toContain("Classified project");
  });

  it.each(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"])(
    "falls back to the neutral label after a %s error",
    (code) => {
      mocked.params = { projectId: P1 };
      mocked.get.data = { name: "Classified project" };
      mocked.get.error = { data: { code } };
      const html = renderToStaticMarkup(<ProjectSwitcher />);
      expect(html).not.toContain("Classified project");
      expect(html).toContain("Projects");
    },
  );

  it("does not mark the sticky project current on global routes, so it stays navigable", () => {
    mocked.pathname = "/admin/ai";
    mocked.params = {};
    mocked.landing.data = { projectId: P1 };
    mocked.list.data = [{ id: P1, name: "Sticky project", myRole: "Owner" }];
    const html = renderToStaticMarkup(<ProjectSwitcher />);
    expect(html).not.toContain('aria-current="true"');
  });

  it("marks the route project current on its own project route", () => {
    mocked.pathname = `/projects/${P1}/tables`;
    mocked.params = { projectId: P1 };
    mocked.list.data = [{ id: P1, name: "Route project", myRole: "Owner" }];
    const html = renderToStaticMarkup(<ProjectSwitcher />);
    expect(html).toContain('aria-current="true"');
  });
});
