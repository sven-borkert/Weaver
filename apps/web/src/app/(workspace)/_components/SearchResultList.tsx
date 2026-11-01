"use client";

import { AlertCircle, FileText, Network, Table2 } from "lucide-react";

import { DocumentKindIcon } from "~/components/icons/DocumentKindIcon";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { type GlobalSearchOption } from "~/lib/knowledge/globalSearch";
import { cn } from "~/lib/utils";

type SearchResultListProps = {
  rawQuery: string;
  options: GlobalSearchOption[];
  activeKey: string | undefined;
  isLoading: boolean;
  requestFailed: boolean;
  semanticUnavailable: boolean;
  onActiveChange: (key: string) => void;
  onChoose: (option: GlobalSearchOption) => void;
  onRetry: () => void;
};

const GROUPS = ["Documents", "Tables", "Entities"] as const;

const GROUP_ICONS = {
  Documents: FileText,
  Tables: Table2,
  Entities: Network,
} satisfies Record<GlobalSearchOption["group"], typeof FileText>;

export function SearchResultList({
  rawQuery,
  options,
  activeKey,
  isLoading,
  requestFailed,
  semanticUnavailable,
  onActiveChange,
  onChoose,
  onRetry,
}: SearchResultListProps) {
  const query = rawQuery.trim();
  const statusMessage = resultStatusMessage({
    queryLength: query.length,
    optionCount: options.length,
    isLoading,
    requestFailed,
  });

  return (
    <div className="min-h-0">
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {statusMessage}
      </p>
      {semanticUnavailable && !requestFailed && !isLoading ? (
        <p
          role="status"
          className="border-info-border bg-info-bg text-info border-b px-4 py-2 text-xs"
        >
          Semantic search unavailable
        </p>
      ) : null}

      <div className="scrollarea max-h-[min(60vh,560px)] overflow-y-auto p-2">
        {query.length === 0 ? <EmptySearchPrompt /> : null}
        {query.length === 1 ? (
          <SearchMessage>Type one more character to search.</SearchMessage>
        ) : null}
        {query.length >= 2 && isLoading ? <SearchLoading /> : null}
        {query.length >= 2 && requestFailed && !isLoading ? (
          <SearchFailure onRetry={onRetry} />
        ) : null}
        {query.length >= 2 &&
        !isLoading &&
        !requestFailed &&
        options.length === 0 ? (
          <SearchMessage>No matches for “{query}”.</SearchMessage>
        ) : null}
        <div
          id="global-search-results"
          role="listbox"
          aria-label="Knowledge search results"
        >
          {query.length >= 2 && !isLoading && !requestFailed
            ? GROUPS.map((group) => {
                const groupOptions = options.filter(
                  (option) => option.group === group,
                );
                if (groupOptions.length === 0) return null;
                const labelId = `global-search-group-${group.toLowerCase()}`;
                const Icon = GROUP_ICONS[group];
                return (
                  <section
                    key={group}
                    role="group"
                    aria-labelledby={labelId}
                    className="not-first:border-line-faint not-first:mt-2 not-first:border-t not-first:pt-2"
                  >
                    <h3
                      id={labelId}
                      className="text-text-3 flex items-center gap-1.5 px-2 py-1 text-xs font-semibold tracking-wide uppercase"
                    >
                      <Icon className="size-3.5" aria-hidden />
                      {group}
                    </h3>
                    <div className="space-y-0.5">
                      {groupOptions.map((option) => (
                        <SearchResultOption
                          key={option.key}
                          option={option}
                          active={option.key === activeKey}
                          onActiveChange={onActiveChange}
                          onChoose={onChoose}
                        />
                      ))}
                    </div>
                  </section>
                );
              })
            : null}
        </div>
      </div>
    </div>
  );
}

function SearchResultOption({
  option,
  active,
  onActiveChange,
  onChoose,
}: {
  option: GlobalSearchOption;
  active: boolean;
  onActiveChange: (key: string) => void;
  onChoose: (option: GlobalSearchOption) => void;
}) {
  return (
    <button
      id={`global-search-${option.key}`}
      type="button"
      role="option"
      aria-selected={active}
      onPointerMove={() => onActiveChange(option.key)}
      onFocus={() => onActiveChange(option.key)}
      onClick={() => onChoose(option)}
      className={cn(
        "focus-visible:ring-brand/50 w-full rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-3",
        active ? "bg-pressed" : "hover:bg-hover",
      )}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="text-text flex min-w-0 items-center gap-1.5 text-sm font-medium">
          {option.kind === "document" ? (
            <DocumentKindIcon
              kind={option.documentKind}
              className="size-3.5 shrink-0"
              aria-hidden="true"
            />
          ) : null}
          <span className="truncate">{option.title}</span>
        </span>
        <span className="text-text-muted shrink-0 truncate text-xs">
          {option.projectName}
        </span>
      </div>
      <OptionDetails option={option} />
    </button>
  );
}

function OptionDetails({ option }: { option: GlobalSearchOption }) {
  if (option.kind === "document") {
    return (
      <div className="mt-1 space-y-0.5">
        {option.headingPath.length > 0 ? (
          <p className="text-text-2 truncate text-xs">
            {option.headingPath.join(" / ")}
          </p>
        ) : null}
        <p className="text-text-3 line-clamp-2 text-xs">{option.snippet}</p>
      </div>
    );
  }

  if (option.kind === "table") {
    return (
      <p className="text-text-3 mt-1 truncate text-xs">
        {option.rowCount} {option.rowCount === 1 ? "row" : "rows"}
        {option.matchingColumns.length > 0
          ? ` · Matching columns: ${option.matchingColumns.join(", ")}`
          : ""}
      </p>
    );
  }

  return (
    <div className="text-text-3 mt-1 space-y-0.5 text-xs">
      <p className="text-text-2 truncate">{option.entityType}</p>
      {option.description ? (
        <p className="line-clamp-2">{option.description}</p>
      ) : option.aliases.length > 0 ? (
        <p className="truncate">Aliases: {option.aliases.join(", ")}</p>
      ) : null}
    </div>
  );
}

function EmptySearchPrompt() {
  return (
    <SearchMessage>
      <span>Search documents, tables, and entities across your projects.</span>
      <span className="text-text-muted mt-2 block text-xs">
        Use ↑ and ↓ to select a result, then Enter to open it.
      </span>
    </SearchMessage>
  );
}

function SearchMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-text-3 flex min-h-36 items-center justify-center px-6 py-10 text-center text-sm">
      <p>{children}</p>
    </div>
  );
}

function SearchLoading() {
  return (
    <div aria-hidden="true" className="space-y-2 p-2">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-4/5" />
    </div>
  );
}

function SearchFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="border-danger-border bg-danger-bg text-danger m-2 flex min-h-32 flex-col items-center justify-center gap-3 rounded-lg border px-5 py-8 text-center">
      <AlertCircle className="size-5" aria-hidden />
      <p className="text-sm">Knowledge search could not be completed.</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function resultStatusMessage({
  queryLength,
  optionCount,
  isLoading,
  requestFailed,
}: {
  queryLength: number;
  optionCount: number;
  isLoading: boolean;
  requestFailed: boolean;
}) {
  if (queryLength < 2) return "Enter at least two characters to search.";
  if (isLoading) return "Searching knowledge.";
  if (requestFailed) return "Knowledge search failed.";
  return `${optionCount} ${optionCount === 1 ? "result" : "results"}.`;
}
