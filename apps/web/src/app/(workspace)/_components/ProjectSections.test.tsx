import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const P1 = "11111111-1111-4111-8111-111111111111";

type GetQuery = {
  data:
    | {
        id: string;
        name: string;
        myRole: "Owner" | "Maintainer" | "Editor" | "Viewer";
        myTrainingRole?: "trainer" | "trainee" | null;
        wikiEnabled?: boolean;
      }
    | undefined;
  error: unknown;
  isLoading: boolean;
};

type LandingQuery = { data: { projectId: string | null } | undefined };

type NavigationMocks = { pathname: string; projectId?: string };

const mocked = vi.hoisted(
  (): {
    query: GetQuery;
    landing: LandingQuery;
    navigation: NavigationMocks;
    landingOptions: { enabled?: boolean } | undefined;
  } => ({
    query: {
      data: undefined,
      error: undefined,
      isLoading: false,
    },
    landing: { data: undefined },
    navigation: { pathname: "/", projectId: undefined },
    landingOptions: undefined,
  }),
);

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: mocked.navigation.projectId }),
  usePathname: () => mocked.navigation.pathname,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    project: { get: { useQuery: () => mocked.query } },
    account: {
      landingProject: {
        useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
          mocked.landingOptions = options;
          return mocked.landing;
        },
      },
    },
  },
}));

vi.mock("./RailLink", () => ({
  RailLink: ({
    href,
    label,
    children,
    active,
  }: {
    href: string;
    label: string;
    children: ReactNode;
    active?: boolean;
  }) => (
    <a
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </a>
  ),
}));

import { ProjectSections } from "./ProjectSections";

function sectionMarkup(html: string, href: string) {
  return new RegExp(`<a[^>]*href="${href}"[^>]*>`).exec(html)?.[0];
}

function sectionLabelOrder(html: string) {
  return [...html.matchAll(/>([A-Za-z]+)<\/a>/g)].map((match) => match[1]);
}

describe("ProjectSections", () => {
  beforeEach(() => {
    mocked.query.data = undefined;
    mocked.query.error = undefined;
    mocked.query.isLoading = false;
    mocked.landing.data = undefined;
    mocked.navigation = { pathname: "/", projectId: undefined };
    mocked.landingOptions = undefined;
  });

  it("renders nothing when no project route is active and no landing project is known", () => {
    expect(renderToStaticMarkup(<ProjectSections />)).toBe("");
  });

  it("renders the landing project's sections on a global route", () => {
    mocked.navigation = { pathname: "/admin/ai", projectId: undefined };
    mocked.landing.data = { projectId: P1 };
    mocked.query.data = { id: P1, name: "Demo", myRole: "Editor" };
    const html = renderToStaticMarkup(<ProjectSections />);
    expect(html).toContain('aria-label="Demo sections"');
    expect(html).toContain(`href="/projects/${P1}/documents"`);
    expect(html).not.toContain('aria-current="page"');
    expect(mocked.landingOptions?.enabled).toBe(true);
  });

  it("shows the project name, the sections list, and Imports for Editor+ members", () => {
    mocked.navigation = {
      projectId: P1,
      pathname: `/projects/${P1}/documents`,
    };
    mocked.query.data = { id: P1, name: "Demo", myRole: "Editor" };

    const html = renderToStaticMarkup(<ProjectSections />);

    expect(html).toContain(">Demo<");
    expect(html).toContain('aria-label="Demo sections"');
    expect(html).toContain(`href="/projects/${P1}/imports"`);
    expect(html).toContain("Imports");
    expect(mocked.landingOptions?.enabled).toBe(false);
  });

  it("hides Imports from the expanded subnav for Viewers", () => {
    mocked.navigation = {
      projectId: P1,
      pathname: `/projects/${P1}/documents`,
    };
    mocked.query.data = { id: P1, name: "Demo", myRole: "Viewer" };

    const html = renderToStaticMarkup(<ProjectSections />);

    expect(html).not.toContain(`href="/projects/${P1}/imports"`);
    expect(html).not.toContain("Imports");
    expect(sectionLabelOrder(html)).toEqual([
      "Documents",
      "Tables",
      "Files",
      "Graph",
      "Tasks",
      "Activity",
      "Settings",
    ]);
  });

  it("links Files to the project artifacts route", () => {
    mocked.navigation = {
      projectId: P1,
      pathname: `/projects/${P1}/documents`,
    };
    mocked.query.data = { id: P1, name: "Demo", myRole: "Viewer" };

    const html = renderToStaticMarkup(<ProjectSections />);

    expect(html).toContain(`href="/projects/${P1}/artifacts"`);
    expect(html).toContain("Files");
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "hides all project sections after a %s error even with cached data",
    (code) => {
      mocked.navigation = { projectId: P1, pathname: `/projects/${P1}` };
      mocked.query.data = { id: P1, name: "Demo", myRole: "Owner" };
      mocked.query.error = { data: { code } };

      const html = renderToStaticMarkup(<ProjectSections />);

      expect(html).toBe("");
      expect(renderToStaticMarkup(<ProjectSections collapsed />)).toBe("");
    },
  );

  it("retains accessible cached sections during a transient refresh failure", () => {
    mocked.navigation = { projectId: P1, pathname: `/projects/${P1}` };
    mocked.query.data = { id: P1, name: "Demo", myRole: "Editor" };
    mocked.query.error = { data: { code: "INTERNAL_SERVER_ERROR" } };
    const html = renderToStaticMarkup(<ProjectSections />);
    expect(html).toContain('aria-label="Demo sections"');
    expect(html).toContain(`href="/projects/${P1}/documents"`);
  });

  it("lists Documents first and Activity before Settings, without Overview", () => {
    mocked.navigation = {
      projectId: P1,
      pathname: `/projects/${P1}/documents`,
    };
    mocked.query.data = { id: P1, name: "Demo", myRole: "Editor" };
    const html = renderToStaticMarkup(<ProjectSections />);
    expect(sectionLabelOrder(html)).toEqual([
      "Documents",
      "Tables",
      "Files",
      "Graph",
      "Imports",
      "Tasks",
      "Activity",
      "Settings",
    ]);
    expect(html).not.toContain("Overview");
    expect(html).not.toContain(`href="/projects/${P1}"`);
  });

  it("shows Wiki between Imports and Tasks when the wiki is enabled", () => {
    mocked.navigation = {
      projectId: P1,
      pathname: `/projects/${P1}/documents`,
    };
    mocked.query.data = {
      id: P1,
      name: "Demo",
      myRole: "Editor",
      wikiEnabled: true,
    };
    expect(
      sectionLabelOrder(renderToStaticMarkup(<ProjectSections />)),
    ).toEqual([
      "Documents",
      "Tables",
      "Files",
      "Graph",
      "Imports",
      "Wiki",
      "Tasks",
      "Activity",
      "Settings",
    ]);
  });

  it("marks a nested document route active by prefix", () => {
    mocked.navigation = {
      projectId: P1,
      pathname: `/projects/${P1}/documents/abc`,
    };
    mocked.query.data = { id: P1, name: "Demo", myRole: "Viewer" };

    const html = renderToStaticMarkup(<ProjectSections />);

    expect(sectionMarkup(html, `/projects/${P1}/documents`)).toContain(
      'aria-current="page"',
    );
  });

  it("renders the collapsed rail as icon-only links with no text heading", () => {
    mocked.navigation = {
      projectId: P1,
      pathname: `/projects/${P1}/documents`,
    };
    mocked.query.data = { id: P1, name: "Demo", myRole: "Editor" };

    const html = renderToStaticMarkup(<ProjectSections collapsed />);

    expect(html).toContain('aria-label="Demo sections"');
    expect(html).toContain('aria-label="Activity"');
    expect(html).toContain('aria-label="Documents"');
    expect(html).toContain('aria-label="Files"');
    expect(html).toContain('aria-label="Imports"');
    expect(html).not.toContain(">Demo<");
  });
});

describe("training navigation", () => {
  it("hides exams for Training Off regardless of project privilege", () => {
    for (const role of ["Viewer", "Maintainer"] as const) {
      mocked.navigation = {
        pathname: `/projects/${P1}/documents`,
        projectId: P1,
      };
      mocked.query.data = {
        id: P1,
        name: "Demo",
        myRole: role,
        myTrainingRole: null,
      };
      expect(renderToStaticMarkup(<ProjectSections />)).not.toContain("Exams");
    }
  });
  it("shows exams between tasks and activity to a Viewer trainee", () => {
    mocked.navigation = { pathname: `/projects/${P1}/exams`, projectId: P1 };
    mocked.query.data = {
      id: P1,
      name: "Demo",
      myRole: "Viewer",
      myTrainingRole: "trainee",
    };
    expect(
      sectionLabelOrder(renderToStaticMarkup(<ProjectSections />)),
    ).toEqual([
      "Documents",
      "Tables",
      "Files",
      "Graph",
      "Tasks",
      "Exams",
      "Activity",
      "Settings",
    ]);
  });
  it("labels the trainer rail link", () => {
    mocked.navigation = { pathname: `/projects/${P1}/exams`, projectId: P1 };
    mocked.query.data = {
      id: P1,
      name: "Demo",
      myRole: "Viewer",
      myTrainingRole: "trainer",
    };
    expect(renderToStaticMarkup(<ProjectSections collapsed />)).toContain(
      'aria-label="Exams"',
    );
  });
});
