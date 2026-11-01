"use client";

import type { ReactNode } from "react";

import { PanelResizeHandle } from "~/components/layout/PanelResizeHandle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { cn } from "~/lib/utils";

export type ContextTab = "contents" | "links" | "history" | "index";

const contextTabs: readonly string[] = [
  "contents",
  "links",
  "history",
  "index",
];

type ContextRailProps = {
  collapsed: boolean;
  activeTab?: ContextTab;
  onActiveTabChange?: (tab: ContextTab) => void;
  contents: ReactNode;
  links: ReactNode;
  history: ReactNode;
  index: ReactNode;
};

export function ContextRail({
  collapsed,
  activeTab,
  onActiveTabChange,
  contents,
  links,
  history,
  index,
}: ContextRailProps) {
  return (
    <aside
      aria-label="Document context"
      className={cn(
        "border-line bg-surface-2 relative flex h-full min-h-0 w-full flex-col overflow-hidden",
        collapsed ? "xl:hidden" : "xl:w-[var(--context-rail-w)] xl:border-l",
      )}
    >
      {collapsed ? null : (
        <PanelResizeHandle
          panel="contextRail"
          label="Resize context panel"
          className="left-0 hidden xl:block"
        />
      )}
      <Tabs
        value={activeTab}
        defaultValue={activeTab ? undefined : "contents"}
        onValueChange={(value) => {
          if (contextTabs.includes(value))
            onActiveTabChange?.(value as ContextTab);
        }}
        className={cn("min-h-0 flex-1 gap-0", collapsed && "xl:hidden")}
      >
        <header className="border-line flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
          <TabsList variant="line" aria-label="Document context sections">
            <TabsTrigger value="contents">Contents</TabsTrigger>
            <TabsTrigger value="links">Links</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="index">Index</TabsTrigger>
          </TabsList>
        </header>
        <div
          data-context-rail-scroll
          className="scrollarea min-h-0 flex-1 overflow-y-auto"
        >
          <TabsContent
            value="contents"
            forceMount
            className="m-0 data-[state=inactive]:hidden"
          >
            {contents}
          </TabsContent>
          <TabsContent
            value="links"
            forceMount
            className="m-0 data-[state=inactive]:hidden"
          >
            {links}
          </TabsContent>
          <TabsContent
            value="history"
            forceMount
            className="m-0 data-[state=inactive]:hidden"
          >
            {history}
          </TabsContent>
          <TabsContent
            value="index"
            forceMount
            className="m-0 data-[state=inactive]:hidden"
          >
            {index}
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
