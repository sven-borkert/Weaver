"use client";

import { Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { GitRuntimeStatus } from "@weaver/git-store/version";
import type { PdfRuntimeStatus } from "~/lib/documents/pdf-runtime-status";

import { AssistantConversation } from "~/components/assistant/AssistantConversation";
import { AssistantPanel } from "~/components/assistant/AssistantPanel";
import {
  AssistantProvider,
  useAssistant,
} from "~/components/assistant/AssistantProvider";
import { AssistantUnavailable } from "~/components/assistant/AssistantUnavailable";
import { ConversationList } from "~/components/assistant/ConversationList";
import { Button } from "~/components/ui/button";
import { BackgroundWorkProvider } from "~/components/background-work/BackgroundWorkProvider";
import {
  PanelResizeHandle,
  PanelWidthsContext,
  type PanelWidthControls,
} from "~/components/layout/PanelResizeHandle";
import { createConversationRequestGuard } from "~/lib/assistant/conversationRequest";
import { humanAssistantError } from "~/lib/assistant/conversationErrors";
import { usePageContext } from "~/lib/assistant/pageContext";
import {
  DEFAULT_PANEL_WIDTHS,
  serializePanelWidthCookie,
  type PanelWidths,
  type ResizablePanel,
} from "~/lib/panel-widths";
import { serializeSidebarCookie } from "~/lib/sidebar-state";
import { api } from "~/trpc/react";
import { cn } from "~/lib/utils";
import { GitRuntimeBanner } from "./GitRuntimeBanner";
import { RuntimeStatusProvider } from "./RuntimeStatusContext";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { LastOpenedProjectRecorder } from "./LastOpenedProjectRecorder";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

// globals.css caps these by the window width (`[data-app-shell]`).
const PANEL_WIDTH_VARIABLES: Record<ResizablePanel, string> = {
  sidebar: "--sidebar-w-pref",
  contextRail: "--context-rail-w-pref",
};

const FULL_HEIGHT_ROUTE =
  /^\/(?:projects\/[^/]+\/(?:documents|tables|graph)|assistant)(?:\/|$)/;

function isShortcut(event: KeyboardEvent, key: string): boolean {
  return (
    !event.defaultPrevented &&
    event.key.toLowerCase() === key &&
    !event.altKey &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey)
  );
}

type ShellProps = {
  children: React.ReactNode;
  /** Server-read cookie state so the first paint matches the stored choice. */
  initialSidebarCollapsed?: boolean;
  initialPanelWidths?: PanelWidths;
  git: GitRuntimeStatus;
  pdf: PdfRuntimeStatus;
};

function ShellFrame({
  children,
  initialSidebarCollapsed = false,
  initialPanelWidths = DEFAULT_PANEL_WIDTHS,
  git,
  pdf,
}: ShellProps) {
  const pathname = usePathname();
  const assistant = useAssistant();
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initialSidebarCollapsed,
  );
  const handleSidebarCollapsedChange = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    document.cookie = serializeSidebarCookie(collapsed);
  };
  const shellRef = useRef<HTMLDivElement>(null);
  const [panelWidths, setPanelWidths] = useState(initialPanelWidths);
  const panelWidthControls = useMemo<PanelWidthControls>(
    () => ({
      widths: panelWidths,
      preview: (panel, width) =>
        shellRef.current?.style.setProperty(
          PANEL_WIDTH_VARIABLES[panel],
          `${width}px`,
        ),
      commit: (panel, width) => {
        setPanelWidths((current) => ({ ...current, [panel]: width }));
        document.cookie = serializePanelWidthCookie(panel, width);
      },
    }),
    [panelWidths],
  );
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const assistantTriggerRef = useRef<HTMLButtonElement>(null);
  const fullHeightWorkspaceRoute = FULL_HEIGHT_ROUTE.test(pathname);
  const onAssistantRoute = pathname.startsWith("/assistant");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isShortcut(event, "k")) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (isShortcut(event, "j")) {
        event.preventDefault();
        assistant.toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assistant]);

  return (
    <PanelWidthsContext.Provider value={panelWidthControls}>
      <LastOpenedProjectRecorder />
      <div
        ref={shellRef}
        className="flex h-screen overflow-hidden"
        data-app-shell="true"
        style={{
          [PANEL_WIDTH_VARIABLES.sidebar]: `${panelWidths.sidebar}px`,
          [PANEL_WIDTH_VARIABLES.contextRail]: `${panelWidths.contextRail}px`,
        }}
      >
        <div className="relative hidden min-h-0 md:flex">
          <Sidebar
            collapsed={sidebarCollapsed}
            onCollapsedChange={handleSidebarCollapsedChange}
          />
          {sidebarCollapsed ? null : (
            <PanelResizeHandle
              panel="sidebar"
              label="Resize sidebar"
              className="-right-[3px] before:left-[2px]"
            />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            searchTriggerRef={searchTriggerRef}
            onOpenSearch={() => setSearchOpen(true)}
            assistantTriggerRef={assistantTriggerRef}
          />
          <GitRuntimeBanner git={git} />
          <main
            className={cn(
              "relative min-h-0 flex-1",
              fullHeightWorkspaceRoute
                ? "overflow-hidden p-3"
                : "scrollarea overflow-y-auto p-6",
            )}
          >
            <RuntimeStatusProvider value={{ pdf }}>
              {children}
            </RuntimeStatusProvider>
          </main>
        </div>
        {/* The route already shows the conversation full-width; never render it twice. */}
        {onAssistantRoute ? null : (
          <AssistantPanel returnFocusRef={assistantTriggerRef}>
            <AssistantPanelContent />
          </AssistantPanel>
        )}
      </div>
      <GlobalSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        triggerRef={searchTriggerRef}
      />
    </PanelWidthsContext.Provider>
  );
}

function AssistantPanelContent() {
  const {
    activeConversationId,
    setActiveConversationId,
    open,
    markSeen,
    requestComposerFocus,
    consumeComposerFocusRequest,
  } = useAssistant();
  const page = usePageContext();
  const [showList, setShowList] = useState(false);
  const utils = api.useUtils();
  const me = api.account.me.useQuery();
  const availability = api.assistant.availability.useQuery(undefined, {
    refetchInterval: 60_000,
    enabled: open,
  });
  const [createRequests] = useState(createConversationRequestGuard);
  useEffect(() => () => createRequests.invalidate(), [createRequests]);
  const create = api.assistant.createConversation.useMutation({
    onSuccess: () => void utils.assistant.listConversations.invalidate(),
  });
  useEffect(() => {
    if (open && activeConversationId) markSeen();
  }, [open, activeConversationId, markSeen]);

  if (availability.data && !availability.data.ready) {
    return (
      <AssistantUnavailable
        reason={availability.data.reason}
        isAdmin={me.data?.role === "Admin"}
      />
    );
  }
  const startNew = () => {
    const request = createRequests.begin();
    requestComposerFocus();
    create.mutate(
      { pinnedProjectId: page.projectId ?? null },
      {
        onSuccess: (c) => {
          if (!createRequests.isCurrent(request)) return;
          setActiveConversationId(c.id);
          setShowList(false);
        },
        onError: (e) => {
          if (!createRequests.isCurrent(request)) return;
          consumeComposerFocusRequest();
          toast.error(
            humanAssistantError(e.message, "Couldn't start a new conversation"),
          );
        },
      },
    );
  };
  if (showList || !activeConversationId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-line flex shrink-0 items-center justify-between border-b px-3 py-2">
          <span className="text-text text-[13px] font-semibold">
            Conversations
          </span>
          <Button
            type="button"
            size="sm"
            onClick={startNew}
            disabled={create.isPending}
          >
            <Plus aria-hidden="true" /> New
          </Button>
        </div>
        <ConversationList
          activeId={activeConversationId}
          onSelect={(id) => {
            createRequests.invalidate();
            setActiveConversationId(id);
            setShowList(false);
          }}
        />
        {!activeConversationId ? (
          <p className="text-text-2 border-line border-t p-4 text-[13px]">
            Ask about anything in your projects.
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <AssistantConversation
      key={activeConversationId}
      conversationId={activeConversationId}
      onNew={startNew}
      onOpenList={() => setShowList(true)}
      onDeleted={() => setActiveConversationId(null)}
      onUnavailable={(message) => {
        // Clearing teleports the panel to the conversation list; without a
        // word the user just sees their conversation vanish.
        setActiveConversationId(null);
        toast.error(
          humanAssistantError(message, "This conversation isn’t available."),
        );
      }}
      fullPage={false}
    />
  );
}

export function AppShell({
  children,
  initialSidebarCollapsed,
  initialPanelWidths,
  git,
  pdf,
}: ShellProps) {
  return (
    <BackgroundWorkProvider>
      <AssistantProvider>
        <ShellFrame
          initialSidebarCollapsed={initialSidebarCollapsed}
          initialPanelWidths={initialPanelWidths}
          git={git}
          pdf={pdf}
        >
          {children}
        </ShellFrame>
      </AssistantProvider>
    </BackgroundWorkProvider>
  );
}
