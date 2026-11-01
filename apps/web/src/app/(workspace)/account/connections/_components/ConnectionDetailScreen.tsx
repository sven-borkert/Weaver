"use client";

import { ArrowLeft, RefreshCw, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { ConnectionDialog } from "./ConnectionDialog";
import { ToolCatalog } from "./ToolCatalog";

export function ConnectionDetailScreen({
  connectionId,
  autoDiscover,
}: {
  connectionId: string;
  autoDiscover?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [canonicalEndpoint, setCanonicalEndpoint] = useState<string | null>(
    null,
  );
  const editRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  const utils = api.useUtils();
  const router = useRouter();
  const query = api.externalMcp.get.useQuery({ id: connectionId });
  const connection = dataUnlessAccessError(query.data, query.error);
  const state = resolveQueryPresentation({
    data: connection,
    error: query.error,
    isLoading: query.isLoading,
  });
  const discover = api.externalMcp.discover.useMutation({
    onSuccess: (result) => {
      setCanonicalEndpoint(result.canonicalEndpoint);
      toast[result.status === "success" ? "success" : "error"](
        result.status === "success"
          ? "Discovery completed"
          : "Discovery failed",
      );
      void utils.externalMcp.invalidate();
    },
    onError: (error) =>
      toast.error(
        error.data?.code === "CONFLICT"
          ? "This connection changed. Reload before discovering again."
          : error.message,
      ),
  });
  const autoStarted = useRef(false);
  useEffect(() => {
    if (
      !autoDiscover ||
      autoStarted.current ||
      !connection ||
      connection.lastDiscoveredAt ||
      connection.discoveryErrorCode
    )
      return;
    autoStarted.current = true;
    discover.mutate({
      id: connection.id,
      expectedRevision: connection.revision,
    });
    router.replace(`/account/connections/${connection.id}`);
  }, [autoDiscover, connection, discover, router]);
  const update = api.externalMcp.update.useMutation({
    onSuccess: () => {
      setCanonicalEndpoint(null);
      toast.success("Endpoint saved");
      void utils.externalMcp.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = api.externalMcp.delete.useMutation({
    onSuccess: async () => {
      toast.success("Connection deleted");
      await utils.externalMcp.invalidate();
      router.push("/account/connections");
    },
    onError: (error) =>
      toast.error(
        error.data?.code === "CONFLICT"
          ? `${error.message}. Check scheduled task references and reload.`
          : error.message,
      ),
  });
  if (state === "loading")
    return (
      <div className="grid gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-44 w-full rounded-xl" />
      </div>
    );
  if (state === "error" || !connection)
    return (
      <div
        role="alert"
        className="border-danger-border bg-danger-bg rounded-xl border p-5"
      >
        <h1 className="text-text text-[18px] font-semibold">
          Connection unavailable
        </h1>
        <p className="text-danger text-[13px]">
          Access was lost or the connection could not be loaded.
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  return (
    <div ref={fallbackRef} tabIndex={-1} className="flex w-full flex-col gap-5">
      <div>
        <Link
          href="/account/connections"
          className="text-text-2 mb-2 inline-flex items-center gap-1 text-[12px] hover:underline"
        >
          <ArrowLeft className="size-3" />
          MCP connections
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-text m-0 text-[20px] font-semibold">
              {connection.name}
            </h1>
            <p className="text-text-3 m-0 text-[12px]">{connection.endpoint}</p>
          </div>
          <div className="flex gap-2">
            <Button
              ref={editRef}
              variant="outline"
              onClick={() => setEditing(true)}
            >
              <Settings />
              Edit
            </Button>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete ${connection.name}?`))
                  remove.mutate({
                    id: connection.id,
                    expectedRevision: connection.revision,
                  });
              }}
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>
      </div>
      <section className="border-line bg-surface grid gap-4 rounded-xl border p-4 sm:grid-cols-3">
        <div>
          <span className="text-text-3 block text-[11px] uppercase">
            Status
          </span>
          <Badge variant={connection.enabled ? "secondary" : "outline"}>
            {connection.enabled ? "Enabled" : "Disabled"}
          </Badge>
          {connection.allowInsecureTls ? (
            <span className="text-danger block text-[12px]">
              Accepts any certificate
            </span>
          ) : null}
        </div>
        <div>
          <span className="text-text-3 block text-[11px] uppercase">
            Discovery
          </span>
          <span className="text-text text-[13px]">
            {connection.discoveryErrorCode
              ? `Failed (${connection.discoveryErrorCode})`
              : connection.lastDiscoveredAt
                ? `${connection.discoveryToolCount ?? 0} tools`
                : "Not tested"}
          </span>
          {connection.discoveryErrorCode && connection.discoveryErrorSummary ? (
            <span className="text-text-3 block text-[12px]">
              {connection.discoveryErrorSummary}
            </span>
          ) : null}
        </div>
        <div className="sm:col-span-3">
          <Button
            variant="outline"
            disabled={discover.isPending}
            onClick={() =>
              discover.mutate({
                id: connection.id,
                expectedRevision: connection.revision,
              })
            }
          >
            <RefreshCw />
            {discover.isPending ? "Testing…" : "Test and discover"}
          </Button>
        </div>
      </section>
      {query.error && connection ? (
        <div
          role="alert"
          className="border-info-border bg-info-bg rounded-lg border p-3"
        >
          <p className="text-text-2 m-0 text-[12px]">
            Showing saved connection data because the latest refresh failed.
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
      {canonicalEndpoint && canonicalEndpoint !== connection.endpoint ? (
        <div
          role="status"
          className="border-info-border bg-info-bg rounded-xl border p-4"
        >
          <p className="text-text m-0 text-[13px]">
            The server redirected discovery to <code>{canonicalEndpoint}</code>.
            Review and explicitly save this endpoint to use it.
          </p>
          <Button
            className="mt-3"
            size="sm"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                id: connection.id,
                expectedRevision: connection.revision,
                patch: { endpoint: canonicalEndpoint },
              })
            }
          >
            Save redirected endpoint
          </Button>
        </div>
      ) : null}
      <ToolCatalog
        connectionId={connection.id}
        totalTools={connection.totalTools}
      />
      <ConnectionDialog
        key={`dialog-${connection.id}`}
        open={editing}
        onOpenChange={setEditing}
        connection={connection}
        returnFocusRef={editRef}
        fallbackFocusRef={fallbackRef}
      />
    </div>
  );
}
