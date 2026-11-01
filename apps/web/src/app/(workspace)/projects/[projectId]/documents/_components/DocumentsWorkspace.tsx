"use client";

import { PanelRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

type DocumentsWorkspaceProps = {
  contextRail?: ReactNode;
  contextRailCollapsed?: boolean;
  onContextRailCollapsedChange?: (collapsed: boolean) => void;
  contextDrawerOpen?: boolean;
  onContextDrawerOpenChange?: (open: boolean) => void;
  consumeContextDrawerCloseFocusRequest?: () => boolean;
  /** aria-label of the scrollable canvas region; defaults to "Document workspace". */
  canvasLabel?: string;
  children: ReactNode;
};

type ResponsiveFocusHandoff = {
  intent: "canvas" | "context";
  focusFulfilled: boolean;
  closeAutoFocusHandled: boolean;
};

const ToolbarTargetContext = createContext<HTMLElement | null>(null);

export function DocumentWorkspaceToolbar({
  children,
}: {
  children: ReactNode;
}) {
  const target = useContext(ToolbarTargetContext);
  return target ? createPortal(children, target) : null;
}

export function DocumentsWorkspace({
  contextRail,
  contextRailCollapsed = false,
  onContextRailCollapsedChange,
  contextDrawerOpen = false,
  onContextDrawerOpenChange,
  consumeContextDrawerCloseFocusRequest,
  canvasLabel = "Document workspace",
  children,
}: DocumentsWorkspaceProps) {
  const [desktopPanels, setDesktopPanels] = useState<boolean>();
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const contextPanelId = useId();
  const workspaceCanvasRef = useRef<HTMLDivElement>(null);
  const desktopContextRef = useRef<HTMLDivElement>(null);
  const desktopContextControlsRef = useRef<HTMLDivElement>(null);
  const contextDrawerTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingResponsiveFocusRef = useRef<ResponsiveFocusHandoff | undefined>(
    undefined,
  );

  const updateResponsivePanelState = useEffectEvent(
    (nextDesktopPanels: boolean) => {
      let intent: ResponsiveFocusHandoff["intent"] | undefined;
      if (nextDesktopPanels && contextDrawerOpen) intent = "canvas";
      else if (
        !nextDesktopPanels &&
        (desktopContextRef.current?.contains(document.activeElement) === true ||
          desktopContextControlsRef.current?.contains(
            document.activeElement,
          ) === true)
      )
        intent = "context";
      pendingResponsiveFocusRef.current = intent
        ? {
            intent,
            focusFulfilled: false,
            closeAutoFocusHandled: intent !== "canvas",
          }
        : undefined;
      setDesktopPanels(nextDesktopPanels);
      if (nextDesktopPanels) onContextDrawerOpenChange?.(false);
    },
  );

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1280px)");
    const updatePanels = () => updateResponsivePanelState(desktopQuery.matches);
    const frame = window.requestAnimationFrame(updatePanels);
    desktopQuery.addEventListener("change", updatePanels);
    return () => {
      window.cancelAnimationFrame(frame);
      desktopQuery.removeEventListener("change", updatePanels);
    };
  }, []);

  useEffect(() => {
    const handoff = pendingResponsiveFocusRef.current;
    if (!handoff) return;
    let target: HTMLElement | null = null;
    if (
      handoff.intent === "canvas" &&
      desktopPanels === true &&
      !contextDrawerOpen
    )
      target = workspaceCanvasRef.current;
    else if (desktopPanels === false && handoff.intent === "context")
      target = contextDrawerTriggerRef.current;
    if (!target) return;
    target.focus();
    if (document.activeElement === target) {
      handoff.focusFulfilled = true;
      if (handoff.closeAutoFocusHandled)
        pendingResponsiveFocusRef.current = undefined;
    }
  }, [contextDrawerOpen, desktopPanels]);

  return (
    <ToolbarTargetContext.Provider value={toolbarTarget}>
      <section className="bg-surface border-line flex h-full min-h-0 min-w-0 flex-col overflow-hidden border">
        {contextRail ? (
          <header
            aria-label="Document page header"
            className="border-line bg-surface flex min-h-10 shrink-0 items-center border-b pointer-coarse:min-h-13"
          >
            <div
              ref={setToolbarTarget}
              data-document-toolbar-slot
              className="flex min-w-0 flex-1 items-center px-1"
            />
            <div
              ref={desktopContextControlsRef}
              aria-label="Document context controls"
              className={cn(
                "border-line bg-surface-2 hidden shrink-0 items-center justify-between gap-2 self-stretch border-l px-2 xl:flex",
                !contextRailCollapsed && "w-[var(--context-rail-w)]",
              )}
            >
              <span className="text-text-2 text-sm font-medium">Context</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={
                  contextRailCollapsed
                    ? "Expand document context"
                    : "Collapse document context"
                }
                aria-expanded={!contextRailCollapsed}
                aria-controls={contextPanelId}
                title={
                  contextRailCollapsed
                    ? "Expand document context"
                    : "Collapse document context"
                }
                onClick={() =>
                  onContextRailCollapsedChange?.(!contextRailCollapsed)
                }
              >
                {contextRailCollapsed ? (
                  <PanelRightOpen aria-hidden="true" />
                ) : (
                  <PanelRightClose aria-hidden="true" />
                )}
              </Button>
            </div>
            {desktopPanels === false ? (
              <div
                aria-label="Document context controls"
                className="border-line bg-surface-2 flex shrink-0 items-center self-stretch border-l px-2 xl:hidden"
              >
                <Dialog
                  open={contextDrawerOpen}
                  onOpenChange={(open) => onContextDrawerOpenChange?.(open)}
                >
                  <DialogTrigger asChild>
                    <Button
                      ref={contextDrawerTriggerRef}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 pointer-coarse:min-h-11"
                    >
                      <PanelRight data-icon="inline-start" aria-hidden="true" />
                      Context
                    </Button>
                  </DialogTrigger>
                  <DialogContent
                    className="bg-surface top-0 right-0 left-auto h-dvh max-h-dvh w-[min(24rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-none xl:hidden"
                    onCloseAutoFocus={(event) => {
                      if (consumeContextDrawerCloseFocusRequest?.())
                        event.preventDefault();
                      const handoff = pendingResponsiveFocusRef.current;
                      if (handoff?.intent !== "canvas") return;
                      event.preventDefault();
                      handoff.closeAutoFocusHandled = true;
                      if (handoff.focusFulfilled)
                        pendingResponsiveFocusRef.current = undefined;
                    }}
                  >
                    <DialogHeader className="border-line border-b px-4 py-4 pr-12">
                      <DialogTitle>Document context</DialogTitle>
                      <DialogDescription className="sr-only">
                        Inspect document links and version history.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="min-h-0 overflow-hidden">{contextRail}</div>
                  </DialogContent>
                </Dialog>
              </div>
            ) : null}
          </header>
        ) : null}

        <div
          className={cn(
            "relative grid min-h-0 min-w-0 flex-1",
            contextRail &&
              !contextRailCollapsed &&
              "xl:grid-cols-[minmax(0,1fr)_var(--context-rail-w)]",
          )}
        >
          <div
            ref={workspaceCanvasRef}
            data-document-canvas
            role="region"
            tabIndex={-1}
            aria-label={canvasLabel}
            className="scrollarea min-h-0 min-w-0 overflow-y-auto outline-none"
          >
            {children}
          </div>
          {desktopPanels !== false ? (
            <div
              id={contextPanelId}
              ref={desktopContextRef}
              className="hidden min-h-0 xl:contents"
            >
              {contextRail}
            </div>
          ) : null}
        </div>
      </section>
    </ToolbarTargetContext.Provider>
  );
}
