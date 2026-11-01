"use client";

import { LoaderCircle, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  flattenGlobalSearchOptions,
  globalSearchResponseIdentity,
  moveGlobalSearchActive,
  type GlobalSearchMove,
  type GlobalSearchOption,
} from "~/lib/knowledge/globalSearch";
import { confirmNavigation } from "~/lib/use-unsaved-changes-guard";
import { withBasePath } from "~/lib/basePath";
import { api } from "~/trpc/react";
import { SearchProjectFilter } from "./SearchProjectFilter";
import { SearchResultList } from "./SearchResultList";

export type GlobalSearchDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
};

export function GlobalSearchDialog(props: GlobalSearchDialogProps) {
  const { open, triggerRef } = props;
  const router = useRouter();
  const pendingNavigationRef = useRef<string | undefined>(undefined);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedProjectIds, setSelectedProjectIds] = useState<
    string[] | undefined
  >(undefined);
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(rawQuery.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [rawQuery]);

  const projectsQuery = api.project.list.useQuery(undefined, {
    enabled: open,
    retry: false,
  });
  const currentIdentity = globalSearchResponseIdentity(
    rawQuery,
    selectedProjectIds,
  );
  const submittedIdentity = globalSearchResponseIdentity(
    debouncedQuery,
    selectedProjectIds,
  );
  const searchQuery = api.search.query.useQuery(
    {
      query: debouncedQuery,
      ...(selectedProjectIds ? { projectIds: selectedProjectIds } : {}),
      limitPerGroup: 8,
    },
    {
      enabled: open && debouncedQuery.length >= 2,
      retry: false,
      // Index jobs land seconds after a save; a cached miss must not outlive them.
      staleTime: 0,
    },
  );
  const visibleResult =
    currentIdentity === submittedIdentity ? searchQuery.data : undefined;
  const trimmedRawQuery = rawQuery.trim();
  const isWaitingForQuery =
    trimmedRawQuery.length >= 2 && currentIdentity !== submittedIdentity;
  const isLoading =
    trimmedRawQuery.length >= 2 &&
    (isWaitingForQuery ||
      (currentIdentity === submittedIdentity &&
        (searchQuery.isLoading ||
          (searchQuery.isFetching && visibleResult === undefined))));
  const requestFailed =
    currentIdentity === submittedIdentity && searchQuery.isError;
  const options = useMemo(
    () =>
      visibleResult && !requestFailed
        ? flattenGlobalSearchOptions(visibleResult)
        : [],
    [requestFailed, visibleResult],
  );
  const visibleActiveKey = options.some((option) => option.key === activeKey)
    ? activeKey
    : undefined;
  const semanticUnavailable =
    visibleResult?.mode === "keyword" ||
    visibleResult?.partial.includes("semantic_unavailable") === true;

  const resetDialog = () => {
    setRawQuery("");
    setDebouncedQuery("");
    setSelectedProjectIds(undefined);
    setActiveKey(undefined);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetDialog();
    props.onOpenChange(nextOpen);
  };

  const handleRawQueryChange = (nextQuery: string) => {
    setRawQuery(nextQuery);
    setActiveKey(undefined);
  };

  const handleProjectIdsChange = (nextIds: string[] | undefined) => {
    setSelectedProjectIds(nextIds);
    setActiveKey(undefined);
  };

  const chooseOption = (option: GlobalSearchOption) => {
    if (!confirmNavigation(withBasePath(option.href))) return;
    pendingNavigationRef.current = option.href;
    handleOpenChange(false);
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const moves: Partial<Record<string, GlobalSearchMove>> = {
      ArrowDown: "next",
      ArrowUp: "previous",
      Home: "first",
      End: "last",
    };
    const move = moves[event.key];
    if (move && options.length > 0) {
      event.preventDefault();
      setActiveKey(moveGlobalSearchActive(options, activeKey, move));
      return;
    }

    if (event.key !== "Enter") return;
    const activeOption = options.find((option) => option.key === activeKey);
    if (!activeOption) return;
    event.preventDefault();
    chooseOption(activeOption);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="border-line bg-surface top-[12%] max-h-[min(76vh,720px)] translate-y-0 gap-0 overflow-hidden border p-0 sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          const pendingNavigation = pendingNavigationRef.current;
          if (pendingNavigation) {
            pendingNavigationRef.current = undefined;
            event.preventDefault();
            window.requestAnimationFrame(() => router.push(pendingNavigation));
            return;
          }
          const trigger = triggerRef.current;
          if (!trigger?.isConnected) return;
          event.preventDefault();
          trigger.focus();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search knowledge</DialogTitle>
          <DialogDescription>
            Search accessible documents, tables, and entities.
          </DialogDescription>
        </DialogHeader>

        <div className="border-line flex items-center gap-2 border-b py-3 pr-12 pl-4">
          <Search className="text-text-muted size-4 shrink-0" aria-hidden />
          <Input
            autoFocus
            maxLength={500}
            value={rawQuery}
            onChange={(event) => handleRawQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            role="combobox"
            aria-label="Search knowledge"
            aria-controls="global-search-results"
            aria-expanded={open}
            aria-activedescendant={
              visibleActiveKey ? `global-search-${visibleActiveKey}` : undefined
            }
            aria-autocomplete="list"
            aria-busy={isLoading}
            placeholder="Search documents, tables, and entities"
            className="h-9 border-0 px-0 text-sm shadow-none focus-visible:ring-0"
          />
          {isLoading ? (
            <LoaderCircle
              className="text-text-muted size-4 shrink-0 animate-spin"
              aria-hidden
            />
          ) : null}
          <SearchProjectFilter
            projects={projectsQuery.data ?? []}
            selectedProjectIds={selectedProjectIds}
            onChange={handleProjectIdsChange}
            disabled={projectsQuery.isLoading || projectsQuery.isError}
          />
        </div>

        <SearchResultList
          rawQuery={rawQuery}
          options={options}
          activeKey={visibleActiveKey}
          isLoading={isLoading}
          requestFailed={requestFailed}
          semanticUnavailable={semanticUnavailable}
          onActiveChange={setActiveKey}
          onChoose={chooseOption}
          onRetry={() => {
            setActiveKey(undefined);
            void searchQuery.refetch();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
