"use client";

import { PanelRight } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

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

type TablesWorkspaceProps = {
  children: ReactNode;
  context?: ReactNode;
  contextRailCollapsed?: boolean;
  contextDrawerOpen?: boolean;
  onContextDrawerOpenChange?: (open: boolean) => void;
};

export function TablesWorkspace({
  children,
  context,
  contextRailCollapsed = false,
  contextDrawerOpen: controlledContextDrawerOpen,
  onContextDrawerOpenChange,
}: TablesWorkspaceProps) {
  const [uncontrolledContextDrawerOpen, setUncontrolledContextDrawerOpen] =
    useState(false);
  const contextDrawerOpen =
    controlledContextDrawerOpen ?? uncontrolledContextDrawerOpen;
  const setContextDrawerOpen = useCallback(
    (open: boolean) => {
      setUncontrolledContextDrawerOpen(open);
      onContextDrawerOpenChange?.(open);
    },
    [onContextDrawerOpenChange],
  );
  const [desktopPanels, setDesktopPanels] = useState<boolean>();

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1280px)");
    const updatePanels = () => {
      setDesktopPanels(desktopQuery.matches);
      if (desktopQuery.matches) {
        setContextDrawerOpen(false);
      }
    };
    const initializeFrame = window.requestAnimationFrame(updatePanels);
    desktopQuery.addEventListener("change", updatePanels);
    return () => {
      window.cancelAnimationFrame(initializeFrame);
      desktopQuery.removeEventListener("change", updatePanels);
    };
  }, [setContextDrawerOpen]);

  return (
    <section className="bg-surface border-line grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden border">
      <div className="flex min-h-0 min-w-0 flex-col">
        {desktopPanels === false && context ? (
          <div className="border-line bg-surface flex shrink-0 items-center gap-2 border-b px-3 py-2 xl:hidden">
            <Dialog
              open={contextDrawerOpen}
              onOpenChange={setContextDrawerOpen}
            >
              <DialogTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <PanelRight data-icon="inline-start" aria-hidden="true" />
                  Context
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-surface top-0 right-0 left-auto h-dvh max-h-dvh w-[min(24rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-none xl:hidden">
                <DialogHeader className="border-line border-b px-4 py-4 pr-12">
                  <DialogTitle>Table context</DialogTitle>
                  <DialogDescription className="sr-only">
                    Inspect information related to this table.
                  </DialogDescription>
                </DialogHeader>
                <div className="scrollarea min-h-0 overflow-y-auto">
                  {context}
                </div>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}

        <div
          className={cn(
            "relative grid min-h-0 min-w-0 flex-1",
            context &&
              (contextRailCollapsed
                ? "xl:grid-cols-[minmax(0,1fr)_3rem]"
                : "xl:grid-cols-[minmax(0,1fr)_var(--context-rail-w)]"),
          )}
        >
          <div
            role="region"
            aria-label="Table workspace"
            data-table-workspace-focus
            tabIndex={-1}
            className="scrollarea min-h-0 min-w-0 overflow-y-auto"
          >
            {children}
          </div>
          {desktopPanels === true && context ? (
            <div className="hidden min-h-0 xl:contents">{context}</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
