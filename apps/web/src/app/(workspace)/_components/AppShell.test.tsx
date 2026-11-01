import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Availability =
  | { ready: true; reason: "ready" }
  | { ready: false; reason: "no_route" | "jobs_disabled" };

const mocked = vi.hoisted(() => ({
  pathname: "/",
  me: undefined as { role: string } | undefined,
  availability: undefined as Availability | undefined,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocked.pathname,
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock("./Sidebar", () => ({ Sidebar: () => <nav>sidebar</nav> }));
vi.mock("./Topbar", () => ({ Topbar: () => <header>topbar</header> }));
vi.mock("./GlobalSearchDialog", () => ({ GlobalSearchDialog: () => null }));
vi.mock("./LastOpenedProjectRecorder", () => ({
  LastOpenedProjectRecorder: () => null,
}));
vi.mock("~/lib/use-mounted", () => ({ useMounted: () => true }));
vi.mock("~/components/assistant/AssistantPanel", () => ({
  AssistantPanel: ({ children }: { children: React.ReactNode }) => (
    <aside aria-label="Assistant">{children}</aside>
  ),
}));
vi.mock("~/components/background-work/BackgroundWorkProvider", () => ({
  BackgroundWorkProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("~/components/assistant/AssistantProvider", () => ({
  AssistantProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useAssistant: () => ({
    open: false,
    activeConversationId: null,
    setActiveConversationId: () => undefined,
    markSeen: () => undefined,
    requestComposerFocus: () => undefined,
    consumeComposerFocusRequest: () => false,
  }),
}));
vi.mock("~/components/background-work/BackgroundWorkProvider", () => ({
  BackgroundWorkProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      assistant: { listConversations: { invalidate: vi.fn() } },
    }),
    account: { me: { useQuery: () => ({ data: mocked.me }) } },
    assistant: {
      availability: { useQuery: () => ({ data: mocked.availability }) },
      getConversation: { useQuery: () => ({ data: undefined }) },
      listConversations: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [], nextCursor: null }] },
          hasNextPage: false,
          fetchNextPage: vi.fn(),
          isFetchingNextPage: false,
          isLoading: false,
        }),
      },
      createConversation: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    project: { list: { useQuery: () => ({ data: undefined }) } },
  },
}));

import { AppShell } from "./AppShell";

const GIT_OK = { status: "ok", version: "2.43.0" } as const;
const PDF_OK = { status: "ok" } as const;

describe("AppShell", () => {
  beforeEach(() => {
    mocked.pathname = "/";
    mocked.me = undefined;
    mocked.availability = undefined;
  });

  it("wraps the workspace in the assistant provider and renders the panel slot after main", () => {
    const html = renderToStaticMarkup(
      <AppShell git={GIT_OK} pdf={PDF_OK}>
        <p>page</p>
      </AppShell>,
    );
    expect(html.indexOf("<main")).toBeLessThan(
      html.indexOf('aria-label="Assistant"'),
    );
  });

  it.each(["/assistant", "/assistant/11111111-1111-4111-8111-111111111111"])(
    "treats %s as a full-height workspace route",
    (pathname) => {
      mocked.pathname = pathname;
      const html = renderToStaticMarkup(
        <AppShell git={GIT_OK} pdf={PDF_OK}>
          <p>page</p>
        </AppShell>,
      );
      expect(html).toMatch(/<main[^>]*class="[^"]*overflow-hidden/);
    },
  );

  it("applies the saved panel widths and offers the sidebar handle while expanded", () => {
    const html = renderToStaticMarkup(
      <AppShell
        git={GIT_OK}
        pdf={PDF_OK}
        initialPanelWidths={{ sidebar: 300, contextRail: 400 }}
      >
        <p>page</p>
      </AppShell>,
    );
    expect(html).toMatch(
      /data-app-shell="true"[^>]*style="--sidebar-w-pref:300px;--context-rail-w-pref:400px"/,
    );
    expect(html).toContain('aria-label="Resize sidebar"');

    const collapsed = renderToStaticMarkup(
      <AppShell git={GIT_OK} pdf={PDF_OK} initialSidebarCollapsed>
        <p>page</p>
      </AppShell>,
    );
    expect(collapsed).toContain(
      'style="--sidebar-w-pref:278px;--context-rail-w-pref:320px"',
    );
    expect(collapsed).not.toContain("Resize sidebar");
  });

  it.each(["/projects/p1/exams/e1", "/projects/p1/documents"])(
    "positions main on %s so absolutely positioned descendants scroll with it instead of the document",
    (pathname) => {
      mocked.pathname = pathname;
      const html = renderToStaticMarkup(
        <AppShell git={GIT_OK} pdf={PDF_OK}>
          <p>page</p>
        </AppShell>,
      );
      expect(html).toMatch(/<main[^>]*class="[^"]*\brelative\b/);
    },
  );

  it("keeps ordinary routes scrollable", () => {
    const html = renderToStaticMarkup(
      <AppShell git={GIT_OK} pdf={PDF_OK}>
        <p>page</p>
      </AppShell>,
    );
    expect(html).toMatch(/<main[^>]*class="[^"]*overflow-y-auto/);
  });

  it("gates the panel content on assistant.availability, showing AssistantUnavailable's admin link for no_route when the viewer is an Admin", () => {
    mocked.availability = { ready: false, reason: "no_route" };
    mocked.me = { role: "Admin" };
    const html = renderToStaticMarkup(
      <AppShell git={GIT_OK} pdf={PDF_OK}>
        <p>page</p>
      </AppShell>,
    );
    expect(html).toContain("set up yet");
    expect(html).toMatch(/<a[^>]*href="\/admin\/settings\/ai"[^>]*>/);
    // The placeholder that would otherwise show with no active conversation
    // must not also render once the gate takes over.
    expect(html).not.toContain("Ask about anything in your projects.");
  });

  it("hides the admin link when jobs_disabled, even for an Admin", () => {
    mocked.availability = { ready: false, reason: "jobs_disabled" };
    mocked.me = { role: "Admin" };
    const html = renderToStaticMarkup(
      <AppShell git={GIT_OK} pdf={PDF_OK}>
        <p>page</p>
      </AppShell>,
    );
    expect(html).toContain("unavailable right now");
    expect(html).not.toMatch(/<a[^>]*href="\/admin\/settings\/ai"[^>]*>/);
  });

  it("warns above the page when the server's Git is too old", () => {
    const html = renderToStaticMarkup(
      <AppShell
        git={{ status: "unsupported", version: "2.34.1", minimum: "2.36.0" }}
        pdf={PDF_OK}
      >
        <p>page</p>
      </AppShell>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The server runs Git 2.34.1");
    expect(html.indexOf("The server runs Git")).toBeLessThan(
      html.indexOf("<main"),
    );
  });

  it("shows no Git warning when Git is supported", () => {
    const html = renderToStaticMarkup(
      <AppShell git={GIT_OK} pdf={PDF_OK}>
        <p>page</p>
      </AppShell>,
    );
    expect(html).not.toContain("Git is not installed");
    expect(html).not.toContain("The server runs Git");
  });
});
