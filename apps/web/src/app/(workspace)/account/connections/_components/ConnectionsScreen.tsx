"use client";

import { Plug, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api, type RouterOutputs } from "~/trpc/react";
import { ConnectionDialog } from "./ConnectionDialog";

export type ExternalConnectionRow =
  RouterOutputs["externalMcp"]["list"]["items"][number];
export const PAGE_SIZE = 25;
export const SEARCH_DEBOUNCE_MS = 200;

export function ConnectionRows({ rows }: { rows: ExternalConnectionRow[] }) {
  if (!rows.length)
    return (
      <div className="border-line bg-surface text-text-3 rounded-xl border p-8 text-center text-[13px]">
        No MCP connections yet.
      </div>
    );
  return (
    <div className="grid gap-3">
      {rows.map((row) => (
        <Link
          key={row.id}
          href={`/account/connections/${row.id}`}
          className="border-line bg-surface hover:bg-hover flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <span>
            <span className="text-text block text-[14px] font-medium">
              {row.name}
            </span>
            <span className="text-text-3 block text-[12px]">
              {row.endpoint}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <Badge variant={row.enabled ? "secondary" : "outline"}>
              {row.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </span>
        </Link>
      ))}
    </div>
  );
}

export function ConnectionsScreen() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearch(rawSearch.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [rawSearch]);
  const query = api.externalMcp.list.useInfiniteQuery(
    { limit: PAGE_SIZE, search: search || undefined },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const data = dataUnlessAccessError(query.data, query.error);
  const state = resolveQueryPresentation({
    data,
    error: query.error,
    isLoading: query.isLoading,
  });
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div ref={fallbackRef} tabIndex={-1} className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-text m-0 text-[20px] font-semibold">
            MCP connections
          </h1>
          <p className="text-text-3 m-0 text-[13px]">
            Connect Weaver to other apps with your own token. Tools you enable
            are available to your assistant in every conversation, your MCP
            clients and your scheduled tasks. When the assistant calls a tool it
            acts as you in that app and may send conversation content to it;
            results may be shared with the AI provider.
          </p>
        </div>
        <Button ref={triggerRef} onClick={() => setDialogOpen(true)}>
          <Plus className="size-4" />
          Add connection
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Plug className="text-text-3 size-4" />
        <Input
          aria-label="Search connections"
          value={rawSearch}
          onChange={(e) => setRawSearch(e.target.value)}
          placeholder="Search connections"
        />
      </div>
      {state === "loading" ? (
        <Skeleton className="h-36 w-full rounded-xl" />
      ) : state === "error" ? (
        <div
          role="alert"
          className="border-danger-border bg-danger-bg rounded-xl border p-4"
        >
          <p className="text-danger m-0 text-[13px]">
            Connections could not be loaded.
          </p>
          <Button
            className="mt-3"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <ConnectionRows rows={rows} />
      )}
      {query.error && data ? (
        <div
          role="alert"
          className="border-info-border bg-info-bg rounded-lg border p-3"
        >
          <p className="text-text-2 m-0 text-[12px]">
            Showing saved results because the latest refresh failed.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void query.refetch()}
          >
            Retry refresh
          </Button>
        </div>
      ) : null}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(c) =>
          router.push(`/account/connections/${c.id}?discover=1`)
        }
        returnFocusRef={triggerRef}
        fallbackFocusRef={fallbackRef}
      />
    </div>
  );
}
