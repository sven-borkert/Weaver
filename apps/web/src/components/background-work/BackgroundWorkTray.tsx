"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BackgroundWorkItem,
  WorkReference,
} from "@weaver/core/jobs/backgroundWorkSchema";

import { Button } from "~/components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { withBasePath } from "~/lib/basePath";
import { confirmNavigation } from "~/lib/use-unsaved-changes-guard";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { visibleWorkReferences } from "~/lib/background-work/presentation";
import { api, usePrincipalId } from "~/trpc/react";
import { BackgroundWorkRow } from "./BackgroundWorkRow";
import { useBackgroundWork } from "./BackgroundWorkProvider";

function Section({
  title,
  items,
  loading,
  empty,
  available,
  onNavigate,
  index,
  onIndexChange,
}: {
  title: string;
  index: number;
  onIndexChange: (index: number) => void;
  items: BackgroundWorkItem[];
  loading: boolean;
  empty: string;
  available: boolean;
  onNavigate: (href: string) => void;
}) {
  return (
    <section
      className="min-w-0"
      aria-labelledby={`background-work-${title.toLowerCase().replaceAll(" ", "-")}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={`background-work-${title.toLowerCase().replaceAll(" ", "-")}`}
          className="text-text text-[13px] font-semibold"
        >
          {title}
        </h3>
        {items.length > 1 ? (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={index === 0}
              aria-label={`Previous ${title.toLowerCase()} item`}
              onClick={() => onIndexChange(index - 1)}
            >
              Previous
            </Button>
            <span className="text-text-3 text-xs">
              {index + 1} / {items.length}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={index === items.length - 1}
              aria-label={`Next ${title.toLowerCase()} item`}
              onClick={() => onIndexChange(index + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
      {loading ? (
        <div className="space-y-2 py-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-4/5" />
        </div>
      ) : items.length ? (
        items
          .slice(index, index + 1)
          .map((item) => (
            <BackgroundWorkRow
              key={`${item.kind}:${item.id}`}
              item={item}
              compact
              onNavigate={onNavigate}
            />
          ))
      ) : available ? (
        <p className="text-text-3 py-3 text-[13px]">{empty}</p>
      ) : null}
    </section>
  );
}

export function BackgroundWorkTray() {
  const {
    open,
    setOpen,
    pageVisible,
    openGeneration,
    openedAt,
    refreshSummary,
  } = useBackgroundWork();
  const principalId = usePrincipalId();
  const router = useRouter();
  const utils = api.useUtils();
  const activeQuery = api.backgroundWork.list.useQuery(
    { audience: "mine", view: "active", limit: 10 },
    {
      enabled: open && pageVisible,
      retry: false,
      refetchInterval: open && pageVisible ? 5_000 : false,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  );
  const recentQuery = api.backgroundWork.list.useQuery(
    { audience: "mine", view: "recent", limit: 10 },
    {
      enabled: open && pageVisible,
      retry: false,
      refetchInterval: open && pageVisible ? 5_000 : false,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  );
  const active = dataUnlessAccessError(activeQuery.data, activeQuery.error);
  const recent = dataUnlessAccessError(recentQuery.data, recentQuery.error);
  const [view, setView] = useState<"active" | "recent">("recent");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIndex, setRecentIndex] = useState(0);
  const visibleActiveIndex = Math.min(
    activeIndex,
    Math.max(0, (active?.items.length ?? 0) - 1),
  );
  const visibleRecentIndex = Math.min(
    recentIndex,
    Math.max(0, (recent?.items.length ?? 0) - 1),
  );
  const references = useMemo(
    () =>
      visibleWorkReferences(
        view === "recent"
          ? (recent?.items.slice(visibleRecentIndex, visibleRecentIndex + 1) ??
              [])
          : [],
      ),
    [recent?.items, visibleRecentIndex, view],
  );
  const signature = references
    .map((item) => `${item.kind}:${item.id}:${item.revision}`)
    .join("|");
  const requestKey = `${principalId ?? "anonymous"}:${openGeneration}:${open ? "open" : "closed"}`;
  const currentKey = useRef(requestKey);
  const submitted = useRef(new Set<string>());
  const pendingNavigation = useRef<string | null>(null);
  const [failed, setFailed] = useState<{
    requestKey: string;
    signature: string;
    items: WorkReference[];
  } | null>(null);
  useEffect(() => {
    currentKey.current = requestKey;
    if (!open) {
      submitted.current.clear();
      void utils.backgroundWork.list.cancel({
        audience: "mine",
        view: "active",
        limit: 10,
      });
      void utils.backgroundWork.list.cancel({
        audience: "mine",
        view: "recent",
        limit: 10,
      });
    }
    return () => {
      currentKey.current = "";
    };
  }, [requestKey, open, utils]);
  const markSeen = api.backgroundWork.markSeen.useMutation();

  const acknowledge = (nextSignature: string, items: WorkReference[]) => {
    if (!nextSignature || !open || items.length === 0) return;
    const gate = `${requestKey}:${nextSignature}`;
    if (submitted.current.has(gate)) return;
    submitted.current.add(gate);
    markSeen.mutate(
      { items },
      {
        onSuccess: () => {
          if (currentKey.current !== requestKey) return;
          setFailed(null);
          void utils.backgroundWork.summary.invalidate();
          void utils.backgroundWork.list.invalidate();
        },
        onError: () => {
          if (currentKey.current === requestKey)
            setFailed({ requestKey, signature: nextSignature, items });
        },
      },
    );
  };

  useEffect(() => {
    const loadedForThisOpen = recentQuery.dataUpdatedAt >= openedAt;
    if (
      open &&
      pageVisible &&
      recent &&
      recentQuery.isSuccess &&
      !recentQuery.isFetching &&
      !recentQuery.error &&
      loadedForThisOpen &&
      signature
    )
      acknowledge(signature, references);
    // `signature` represents the successful page that just rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    recent,
    signature,
    requestKey,
    open,
    pageVisible,
    openedAt,
    recentQuery.isSuccess,
    recentQuery.isFetching,
    recentQuery.error,
    recentQuery.dataUpdatedAt,
  ]);

  const unavailable = Boolean(activeQuery.error ?? recentQuery.error);
  const refresh = () => {
    void Promise.all([
      activeQuery.refetch(),
      recentQuery.refetch(),
      refreshSummary(),
    ]);
  };
  const navigate = (href: string) => {
    if (!confirmNavigation(withBasePath(href))) return;
    pendingNavigation.current = href;
    setOpen(false);
  };

  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] min-w-0 overflow-hidden sm:max-w-3xl [@media(max-height:30rem)]:gap-2 [@media(max-height:30rem)]:p-3"
      onCloseAutoFocus={(event) => {
        const href = pendingNavigation.current;
        if (!href) return;
        pendingNavigation.current = null;
        event.preventDefault();
        window.requestAnimationFrame(() => router.push(href));
      }}
    >
      <DialogHeader>
        <DialogTitle>Background work</DialogTitle>
        <DialogDescription className="[@media(max-height:30rem)]:hidden">
          Work running for you and recent results across your projects.
        </DialogDescription>
      </DialogHeader>
      {unavailable && failed?.requestKey !== requestKey ? (
        <div className="border-danger/30 bg-danger/5 flex items-center justify-between gap-3 rounded-lg border p-3 [@media(max-height:30rem)]:p-2">
          <p className="text-text text-[13px]">
            Updates unavailable. Existing results may be out of date.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {failed?.requestKey === requestKey ? (
        <div className="border-warning/30 bg-warning/5 flex items-center justify-between gap-3 rounded-lg border p-3 [@media(max-height:30rem)]:p-2">
          <p className="text-text text-[13px]">
            {unavailable
              ? "Updates unavailable. Couldn’t mark results as seen."
              : "Couldn’t mark these results as seen."}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (unavailable) refresh();
              submitted.current.delete(`${requestKey}:${failed.signature}`);
              acknowledge(failed.signature, failed.items);
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Work status"
      >
        <Button
          variant={view === "active" ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={view === "active"}
          onClick={() => setView("active")}
        >
          In progress ({active?.items.length ?? 0})
        </Button>
        <Button
          variant={view === "recent" ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={view === "recent"}
          onClick={() => setView("recent")}
        >
          Recent results ({recent?.items.length ?? 0})
        </Button>
      </div>
      {view === "active" ? (
        <Section
          title="In progress"
          index={visibleActiveIndex}
          onIndexChange={setActiveIndex}
          items={active?.items ?? []}
          loading={activeQuery.isLoading}
          empty="No work is running."
          available={active !== undefined}
          onNavigate={navigate}
        />
      ) : (
        <Section
          title="Recent results"
          index={visibleRecentIndex}
          onIndexChange={setRecentIndex}
          items={recent?.items ?? []}
          loading={recentQuery.isLoading}
          empty="No recent results."
          available={recent !== undefined}
          onNavigate={navigate}
        />
      )}
      <DialogFooter className="flex-row items-center justify-between sm:justify-between [@media(max-height:30rem)]:-mx-3 [@media(max-height:30rem)]:-mb-3 [@media(max-height:30rem)]:p-3">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
        <Button asChild variant="outline">
          <Link
            href="/account/background-work"
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              navigate("/account/background-work");
            }}
          >
            View all background work
          </Link>
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
