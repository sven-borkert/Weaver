import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "~/components/ui/tooltip";

const mocked = vi.hoisted(() => ({
  pathname: "/home",
  query: {
    data: { role: "Admin" },
    error: undefined as { data: { code: string } } | undefined,
    isFetching: false,
  },
  dueCount: {
    data: undefined as { count: number; isReviewer: boolean } | undefined,
    error: undefined as { data: { code: string } } | undefined,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocked.pathname,
  useParams: () => ({}),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    account: { me: { useQuery: () => mocked.query } },
    review: { dueCount: { useQuery: () => mocked.dueCount } },
  },
}));
vi.mock("./ProjectSections", () => ({
  ProjectSections: () => <ul aria-label="Demo sections" />,
}));
vi.mock("./ProjectSwitcher", () => ({
  ProjectSwitcher: () => <button type="button" aria-label="Switch project" />,
}));
vi.mock("./UserMenu", () => ({
  UserMenu: () => <button type="button" aria-label="User menu" />,
}));

import { Sidebar } from "./Sidebar";

function render(collapsed = false) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Sidebar collapsed={collapsed} onCollapsedChange={() => undefined} />
    </TooltipProvider>,
  );
}

describe("Sidebar administration navigation", () => {
  beforeEach(() => {
    mocked.query.data = { role: "Admin" };
    mocked.query.error = undefined;
    mocked.query.isFetching = false;
  });

  it("renders Administration for a settled Admin identity", () => {
    const html = render();

    expect(html).toContain("Administration");
    expect(html).toContain('href="/admin/settings"');
    expect(html).not.toContain('href="/admin/connections"');
    expect(html).not.toContain('href="/admin/remote-instances"');
    expect(html).toContain('href="/admin/diagnostics"');
    expect(html).toContain('href="/admin/projects"');
    expect(html).toContain('href="/admin/users"');
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "hides cached Administration navigation after a %s error",
    (code) => {
      mocked.query.error = { data: { code } };

      const html = render();

      expect(html).not.toContain("Administration");
      expect(html).not.toContain('href="/admin/settings"');
      expect(html).not.toContain('href="/admin/remote-instances"');
      expect(html).not.toContain('href="/admin/diagnostics"');
      expect(html).not.toContain('href="/admin/projects"');
      expect(html).not.toContain('href="/admin/users"');
    },
  );

  it("keeps cached Administration navigation while identity is refreshing", () => {
    mocked.query.isFetching = true;

    const html = render();

    expect(html).toContain("Administration");
    expect(html).toContain('href="/admin/settings"');
    expect(html).not.toContain('href="/admin/connections"');
    expect(html).not.toContain('href="/admin/remote-instances"');
    expect(html).toContain('href="/admin/diagnostics"');
    expect(html).toContain('href="/admin/projects"');
    expect(html).toContain('href="/admin/users"');
  });
});

describe("Sidebar collapse", () => {
  beforeEach(() => {
    mocked.query.data = { role: "Admin" };
    mocked.query.error = undefined;
    mocked.query.isFetching = false;
  });

  it("offers a collapse control while expanded", () => {
    const html = render(false);

    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('data-collapsed="true"');
    expect(html).toContain("Knowledge, connected");
  });

  it("renders an icon rail with an expand control while collapsed", () => {
    const html = render(true);

    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-label="Show projects"');
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('href="/admin/settings"');
    expect(html).not.toContain('href="/admin/remote-instances"');
    expect(html).toContain('aria-label="Diagnostics"');
    expect(html).toContain('href="/admin/diagnostics"');
    expect(html).toContain('aria-label="Users"');
    expect(html).toContain('href="/admin/projects"');
    expect(html).toContain('href="/admin/users"');
    expect(html).not.toContain("Knowledge, connected");
    expect(html).not.toContain("Administration");
  });

  it("hides the Settings rail entry for non-admins while collapsed", () => {
    mocked.query.data = { role: "User" };

    const html = render(true);

    expect(html).not.toContain('href="/admin/settings"');
    expect(html).not.toContain('href="/admin/remote-instances"');
    expect(html).not.toContain('href="/admin/diagnostics"');
    expect(html).not.toContain('href="/admin/users"');
  });

  it("has no Home link in either mode", () => {
    expect(render(false)).not.toContain('href="/home"');
    expect(render(true)).not.toContain('href="/home"');
    expect(render(false)).not.toContain(">Workspace<");
  });

  it("shows the brand mark before the Weaver name in both modes", () => {
    const expanded = render(false);
    const mark = 'viewBox="0 0 40 36"';
    expect(expanded).toContain(mark);
    expect(expanded.indexOf(mark)).toBeLessThan(expanded.indexOf("Weaver"));
    expect(render(true)).toContain(mark);
  });

  it("leaves the user menu to the top bar in both modes", () => {
    expect(render(false)).not.toContain('aria-label="User menu"');
    expect(render(true)).not.toContain('aria-label="User menu"');
  });

  it("renders the project switcher in both modes", () => {
    expect(render(false)).toContain('aria-label="Switch project"');
    expect(render(true)).toContain('aria-label="Switch project"');
  });

  it("lists no project links; the switcher picks the project", () => {
    for (const role of ["Admin", "User"]) {
      mocked.query.data = { role };
      const html = render(false);
      expect(html).not.toContain('href="/projects/');
      expect(html).not.toContain('aria-label="Show projects"');
      expect(html).toContain('aria-label="Demo sections"');
    }
    mocked.query.data = { role: "User" };
    const html = render(false);
    expect(html).not.toContain(">Projects<");
    expect(html).toContain('aria-label="Demo sections"');
  });
});

describe("Sidebar reviews navigation", () => {
  beforeEach(() => {
    mocked.pathname = "/home";
    mocked.query.data = { role: "User" };
    mocked.query.error = undefined;
    mocked.query.isFetching = false;
    mocked.dueCount.data = undefined;
    mocked.dueCount.error = undefined;
  });

  it("groups Open and Recently reviewed under a Reviews headline", () => {
    mocked.dueCount.data = { count: 3, isReviewer: true };

    const html = render(false);

    expect(html).toContain(">Reviews</div>");
    expect(html).toContain('href="/reviews"');
    expect(html).toContain(">Open<");
    expect(html).toContain('href="/reviews/recent"');
    expect(html).toContain("Recently reviewed");
    expect(html.indexOf(">Reviews</div>")).toBeGreaterThan(
      html.indexOf("Demo sections"),
    );
  });

  it("links Open with a count badge name for a reviewer", () => {
    mocked.dueCount.data = { count: 3, isReviewer: true };

    expect(render(false)).toContain('aria-label="Open reviews, 3 due"');
    expect(render(true)).toContain('aria-label="Open reviews, 3 due"');
  });

  it("shows the visible count in the expanded sidebar", () => {
    mocked.dueCount.data = { count: 3, isReviewer: true };

    expect(render(false)).toContain(">3</span>");
  });

  it.each([false, true])(
    "shows no badge when nothing is due (collapsed: %s)",
    (collapsed) => {
      mocked.dueCount.data = { count: 0, isReviewer: true };

      const html = render(collapsed);

      expect(html).toContain('href="/reviews"');
      expect(html).toContain('aria-label="Open reviews"');
      expect(html).not.toContain('due"');
      expect(html).not.toContain("rounded-full");
    },
  );

  it("marks only the matching item active in the expanded sidebar", () => {
    mocked.dueCount.data = { count: 0, isReviewer: true };

    mocked.pathname = "/reviews";
    let html = render(false);
    expect(html).toMatch(/aria-current="page"[^>]*href="\/reviews"/);
    expect(html).not.toMatch(/href="\/reviews\/recent"[^>]*aria-current/);
    expect(html).not.toMatch(
      /aria-current="page"[^>]*href="\/reviews\/recent"/,
    );

    mocked.pathname = "/reviews/recent";
    html = render(false);
    expect(html).toMatch(/aria-current="page"[^>]*href="\/reviews\/recent"/);
    expect(html).not.toMatch(/aria-current="page"[^>]*href="\/reviews"/);
  });

  it.each(["/reviews", "/reviews/recent"])(
    "keeps the single rail icon active on %s",
    (pathname) => {
      mocked.dueCount.data = { count: 0, isReviewer: true };
      mocked.pathname = pathname;

      expect(render(true)).toMatch(/aria-current="page"[^>]*href="\/reviews"/);
    },
  );

  it.each([false, true])(
    "offers only the recent list to a non-reviewer (collapsed: %s)",
    (collapsed) => {
      mocked.dueCount.data = { count: 0, isReviewer: false };

      const html = render(collapsed);

      expect(html).not.toContain('href="/reviews"');
      expect(html).toContain('href="/reviews/recent"');
      if (collapsed) expect(html).toContain('aria-label="Recently reviewed"');
    },
  );

  it.each([false, true])(
    "renders no Open link while loading or after a failure (collapsed: %s)",
    (collapsed) => {
      expect(render(collapsed)).not.toContain('href="/reviews"');

      mocked.dueCount.error = { data: { code: "INTERNAL_SERVER_ERROR" } };
      expect(render(collapsed)).not.toContain('href="/reviews"');
    },
  );
});
