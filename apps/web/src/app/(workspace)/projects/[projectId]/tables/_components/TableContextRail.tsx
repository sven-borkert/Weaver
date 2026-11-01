"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { PanelResizeHandle } from "~/components/layout/PanelResizeHandle";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { cn } from "~/lib/utils";

type TableContextTab = "history" | "backlinks";

type TableContextRailProps = {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  activeTab: TableContextTab;
  onActiveTabChange: (tab: TableContextTab) => void;
  history: ReactNode;
  backlinks: ReactNode;
};

export function TableContextRail({
  collapsed,
  onCollapsedChange,
  activeTab,
  onActiveTabChange,
  history,
  backlinks,
}: TableContextRailProps) {
  if (collapsed) {
    return (
      <>
        <aside
          aria-label="Table context"
          className="border-line bg-surface-2 hidden min-h-0 border-l pt-3 xl:flex xl:justify-center"
        >
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Expand table context"
            aria-expanded="false"
            className="shrink-0"
            onClick={() => onCollapsedChange(false)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
        </aside>
        <ExpandedTableContextRail
          className="xl:hidden"
          activeTab={activeTab}
          onActiveTabChange={onActiveTabChange}
          onCollapsedChange={onCollapsedChange}
          history={history}
          backlinks={backlinks}
        />
      </>
    );
  }

  return (
    <ExpandedTableContextRail
      activeTab={activeTab}
      onActiveTabChange={onActiveTabChange}
      onCollapsedChange={onCollapsedChange}
      history={history}
      backlinks={backlinks}
    />
  );
}

function ExpandedTableContextRail({
  className,
  activeTab,
  onActiveTabChange,
  onCollapsedChange,
  history,
  backlinks,
}: {
  className?: string;
  activeTab: TableContextTab;
  onActiveTabChange: (tab: TableContextTab) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  history: ReactNode;
  backlinks: ReactNode;
}) {
  return (
    <aside
      aria-label="Table context"
      className={cn(
        "border-line bg-surface-2 relative flex h-full min-h-0 w-full flex-col overflow-hidden xl:w-[var(--context-rail-w)] xl:border-l",
        className,
      )}
    >
      <PanelResizeHandle
        panel="contextRail"
        label="Resize context panel"
        className="left-0 hidden xl:block"
      />
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (value === "history" || value === "backlinks") {
            onActiveTabChange(value);
          }
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <header className="border-line flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
          <TabsList variant="line" aria-label="Table context sections">
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="backlinks">Backlinks</TabsTrigger>
          </TabsList>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Collapse table context"
            aria-expanded="true"
            className="hidden xl:inline-flex"
            onClick={() => onCollapsedChange(true)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </header>
        <div className="scrollarea min-h-0 flex-1 overflow-y-auto">
          <TabsContent
            value="history"
            forceMount
            className="m-0 data-[state=inactive]:hidden"
          >
            {history}
          </TabsContent>
          <TabsContent
            value="backlinks"
            forceMount
            className="m-0 data-[state=inactive]:hidden"
          >
            {backlinks}
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
