"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { MAX_BULK_TOOL_REVIEWS } from "@weaver/core/externalMcp/limits";
import { suggestedToolEffect } from "@weaver/core/externalMcp/toolState";
import {
  externalToolState,
  type ExternalToolState,
} from "@weaver/core/externalMcp/toolState";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";

type Tool = RouterOutputs["externalMcp"]["tools"]["items"][number];
type ToolKey = RouterOutputs["externalMcp"]["toolKeys"]["items"][number];
type Filter = Omit<RouterInputs["externalMcp"]["toolKeys"], "connectionId">;
type Effect = "read" | "write";

export const TOOL_PAGE_SIZE = 100;
export const STATE_LABEL: Record<ExternalToolState, string> = {
  new: "New",
  changed: "Changed",
  reviewed: "Reviewed",
  unavailable: "Unavailable",
  unsupported: "Unsupported",
};
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

const shownFrom = (tool: Tool) => ({
  enabled: tool.enabled,
  effect: tool.effect ?? suggestedToolEffect(tool.discoveredDefinition),
});

export function ToolTableRow({ tool }: { tool: Tool }) {
  const utils = api.useUtils();
  const [shown, setShown] = useState(() => shownFrom(tool));
  const [seen, setSeen] = useState(tool);
  const [conflict, setConflict] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (seen !== tool) {
    setSeen(tool);
    setShown(shownFrom(tool));
    setConflict(false);
  }
  const review = api.externalMcp.reviewTools.useMutation({
    onSuccess: () => void utils.externalMcp.invalidate(),
    onError: (error) => {
      setShown(shownFrom(tool));
      if (error.data?.code === "CONFLICT") setConflict(true);
      toast.error(error.message);
      void utils.externalMcp.invalidate();
    },
  });
  const state = externalToolState(tool);
  const editable = state !== "unavailable" && state !== "unsupported";
  const disabled = !editable || review.isPending;
  const save = (change: { enabled: boolean } | { effect: Effect }) => {
    setShown((current) => ({ ...current, ...change }));
    review.mutate({
      connectionId: tool.connectionId,
      items: [
        {
          toolId: tool.id,
          expectedRemoteDigest: tool.discoveredRemoteDigest,
          ...change,
        },
      ],
    });
  };
  const definition = tool.discoveredDefinition as {
    inputSchema?: unknown;
    supportStatus?: { reason?: string };
  };
  return (
    <>
      <TableRow>
        <TableCell className="w-10">
          <input
            type="checkbox"
            aria-label={`Enable ${tool.remoteName}`}
            checked={shown.enabled}
            disabled={disabled}
            onChange={(event) => save({ enabled: event.target.checked })}
          />
        </TableCell>
        <TableCell>
          <button
            type="button"
            className="text-text cursor-pointer text-left text-[13px] font-medium"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {tool.remoteName}
          </button>
        </TableCell>
        <TableCell
          className="text-text-3 max-w-[28rem] truncate text-[12px]"
          title={tool.description ?? undefined}
        >
          {tool.description ?? "—"}
        </TableCell>
        <TableCell>
          <Badge variant="outline">
            {conflict ? "Changed on server" : STATE_LABEL[state]}
          </Badge>
        </TableCell>
        <TableCell className="w-28">
          <select
            aria-label={`Effect of ${tool.remoteName}`}
            value={shown.effect}
            disabled={disabled}
            onChange={(event) =>
              save({ effect: event.target.value === "read" ? "read" : "write" })
            }
            className="border-line bg-surface text-text rounded-md border px-2 py-1 text-[12px]"
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </select>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={5}>
            <p className="text-text-2 m-0 text-[12px] whitespace-pre-wrap">
              {tool.description ?? "No description provided."}
            </p>
            {state === "unsupported" && definition.supportStatus?.reason ? (
              <p role="alert" className="text-danger m-0 text-[12px]">
                Schema unavailable: {definition.supportStatus.reason}
              </p>
            ) : null}
            <pre className="border-line bg-subtle text-text-2 mt-2 max-h-64 overflow-auto rounded-lg border p-3 text-[11px] whitespace-pre-wrap">
              {JSON.stringify(definition.inputSchema ?? {}, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export function BulkReviewDialog({
  connectionId,
  enabled,
  keys,
  onClose,
}: {
  connectionId: string;
  enabled: boolean;
  keys: ToolKey[];
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const review = api.externalMcp.reviewTools.useMutation();
  const [applied, setApplied] = useState(0);
  const [running, setRunning] = useState(false);
  const editable = keys.filter(
    (key) => key.state !== "unavailable" && key.state !== "unsupported",
  );
  const approving = editable.filter(
    (key) => key.state === "new" || key.state === "changed",
  ).length;
  const run = async () => {
    setRunning(true);
    let done = 0;
    try {
      for (const batch of chunk(editable, MAX_BULK_TOOL_REVIEWS)) {
        await review.mutateAsync({
          connectionId,
          items: batch.map((key) => ({
            toolId: key.id,
            expectedRemoteDigest: key.discoveredRemoteDigest,
            enabled,
          })),
        });
        done += batch.length;
        setApplied(done);
      }
      toast.success(`${enabled ? "Enabled" : "Disabled"} ${done} tools`);
      onClose();
    } catch (error) {
      toast.error(
        `${(error as Error).message}. ${done} of ${editable.length} tools were changed.`,
      );
      // Retry must start from freshly fetched keys.
      onClose();
    } finally {
      setRunning(false);
      void utils.externalMcp.invalidate();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => (!open && !running ? onClose() : null)}
    >
      <DialogContent aria-busy={running}>
        <DialogHeader>
          <DialogTitle>
            {enabled ? "Enable" : "Disable"} {editable.length} tools?
          </DialogTitle>
          <DialogDescription>
            {keys.length - editable.length > 0
              ? `${keys.length - editable.length} unavailable or unsupported tools are skipped. `
              : ""}
            {approving > 0
              ? `${approving} tools are New or Changed; this approves their current definitions.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {running ? (
          <p className="text-text-3 text-[12px]">
            {applied} of {editable.length} applied…
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={running || editable.length === 0}
            onClick={() => void run()}
          >
            {enabled ? "Enable all" : "Disable all"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ToolCatalog({
  connectionId,
  totalTools,
}: {
  connectionId: string;
  totalTools: number;
}) {
  const utils = api.useUtils();
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [reviewState, setReviewState] = useState<
    "" | NonNullable<Filter["reviewState"]>
  >("");
  const [effect, setEffect] = useState<"" | Effect>("");
  const [enabledFilter, setEnabledFilter] = useState<"" | "on" | "off">("");
  const [bulk, setBulk] = useState<{
    enabled: boolean;
    keys: ToolKey[];
  } | null>(null);
  const [loadingKeys, setLoadingKeys] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(rawSearch.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [rawSearch]);
  const filter = {
    connectionId,
    search: search || undefined,
    reviewState: reviewState || undefined,
    effect: effect || undefined,
    enabled: enabledFilter === "" ? undefined : enabledFilter === "on",
  };
  const query = api.externalMcp.tools.useInfiniteQuery(
    { ...filter, limit: TOOL_PAGE_SIZE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const tools = query.data?.pages.flatMap((page) => page.items) ?? [];
  const startBulk = async (
    enabled: boolean,
    keysFilter: Filter & { connectionId: string } = filter,
  ) => {
    setLoadingKeys(true);
    try {
      const { items } = await utils.externalMcp.toolKeys.fetch(keysFilter, {
        staleTime: 0,
      });
      setBulk({ enabled, keys: items });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoadingKeys(false);
    }
  };
  return (
    <section
      aria-labelledby="tool-catalog-title"
      className="flex flex-col gap-3"
    >
      <div>
        <h2
          id="tool-catalog-title"
          className="text-text m-0 text-[16px] font-semibold"
        >
          Tools
        </h2>
        <p className="text-text-3 m-0 text-[12px]">
          {totalTools} discovered tools. Changes save immediately and approve
          the tool&apos;s current definition.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Input
          aria-label="Search tools"
          placeholder="Search name or description"
          value={rawSearch}
          onChange={(e) => setRawSearch(e.target.value)}
        />
        <select
          aria-label="Review state"
          value={reviewState}
          onChange={(e) => setReviewState(e.target.value as typeof reviewState)}
          className="border-line bg-surface text-text rounded-lg border px-3 text-[13px]"
        >
          <option value="">All states</option>
          <option value="unreviewed">New</option>
          <option value="changed">Changed</option>
          <option value="reviewed">Reviewed</option>
          <option value="removed">Unavailable</option>
          <option value="unsupported">Unsupported</option>
        </select>
        <select
          aria-label="Effect"
          value={effect}
          onChange={(e) => setEffect(e.target.value as typeof effect)}
          className="border-line bg-surface text-text rounded-lg border px-3 text-[13px]"
        >
          <option value="">Read and write</option>
          <option value="read">Read</option>
          <option value="write">Write</option>
        </select>
        <select
          aria-label="Enabled"
          value={enabledFilter}
          onChange={(e) =>
            setEnabledFilter(e.target.value as typeof enabledFilter)
          }
          className="border-line bg-surface text-text rounded-lg border px-3 text-[13px]"
        >
          <option value="">Enabled and disabled</option>
          <option value="on">Enabled</option>
          <option value="off">Disabled</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={loadingKeys || totalTools === 0}
          onClick={() =>
            void startBulk(true, {
              connectionId,
              search: undefined,
              reviewState: undefined,
              effect: "read",
              enabled: false,
              suggestedEffect: "read",
            })
          }
        >
          Enable all read tools
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={loadingKeys || !tools.length}
          onClick={() => void startBulk(true)}
        >
          Enable all matching
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={loadingKeys || !tools.length}
          onClick={() => void startBulk(false)}
        >
          Disable all matching
        </Button>
      </div>
      {query.isLoading ? (
        <p className="text-text-3 text-[13px]">Loading catalog…</p>
      ) : query.error ? (
        <div role="alert">
          <p className="text-danger text-[13px]">
            Could not load the tool catalog.
          </p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : tools.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>On</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Effect</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tools.map((tool) => (
              <ToolTableRow key={tool.id} tool={tool} />
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="border-line bg-surface text-text-3 rounded-xl border p-6 text-center text-[13px]">
          No tools match this catalog view.
        </p>
      )}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more tools"}
        </Button>
      ) : null}
      {bulk ? (
        <BulkReviewDialog
          connectionId={connectionId}
          enabled={bulk.enabled}
          keys={bulk.keys}
          onClose={() => setBulk(null)}
        />
      ) : null}
    </section>
  );
}
