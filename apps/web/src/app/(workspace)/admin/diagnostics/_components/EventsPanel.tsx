"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { ClientDateTime } from "~/components/ui/client-date";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  correlationFromParams,
  PROCESSING_CORRELATIONS,
  type CorrelationFilters,
  DEFAULT_FILTERS,
  toListInput,
  type EventFilters,
} from "./eventFilters";

type EventRow = RouterOutputs["diagnostics"]["listEvents"]["items"][number];
type BodyPart = "none" | "request" | "response";

const SEVERITY_TONE: Record<EventRow["severity"], string> = {
  debug: "text-text-muted",
  info: "text-text-2",
  warn: "text-review",
  error: "text-danger",
};

const CORRELATIONS = [
  "requestId",
  "jobId",
  "runId",
  "userId",
  "credentialId",
  "projectId",
  "generationId",
  "documentId",
  "connectionId",
] as const;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-text-3 text-[11px] uppercase">{label}</span>
      <span className="text-text-2 font-mono text-[12px] break-all">
        {value}
      </span>
    </div>
  );
}

function EventDetailDialog({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const [part, setPart] = useState<BodyPart>("none");
  const [offset, setOffset] = useState(0);
  const [text, setText] = useState("");
  const detail = api.diagnostics.getEvent.useQuery(
    { id: id ?? "", body: part, offset },
    { enabled: id !== null },
  );
  const event = detail.data?.event;
  const body = detail.data?.body ?? null;
  const shownText =
    offset === 0 ? (body?.text ?? "") : text + (body?.text ?? "");
  const reset = () => {
    setPart("none");
    setOffset(0);
    setText("");
  };

  return (
    <Dialog
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Diagnostic event</DialogTitle>
        </DialogHeader>
        {detail.error && !event ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-text-2 m-0 text-[13px]">
              {part === "none"
                ? "This event could not be loaded."
                : "This body could not be loaded. Bodies require membership in the event's project."}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                part === "none" ? void detail.refetch() : reset()
              }
            >
              {part === "none" ? "Retry" : "Back to event details"}
            </Button>
          </div>
        ) : detail.isLoading || !event ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text-3 text-[11px] uppercase">
                Reference
              </span>
              <code className="bg-subtle rounded px-1.5 py-0.5 text-[12px]">
                {event.id.slice(0, 8)}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigator.clipboard?.writeText(event.id.slice(0, 8))
                }
              >
                Copy
              </Button>
            </div>
            <p className="text-text m-0 text-[13px]">{event.message}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Id" value={event.id} />
              <Field label="Time" value={event.createdAt.toISOString()} />
              <Field label="Runtime" value={event.runtime} />
              <Field label="Severity" value={event.severity} />
              <Field label="Category" value={event.category} />
              <Field label="Event" value={event.event} />
              <Field label="Outcome" value={event.outcome ?? "—"} />
              <Field
                label="Status"
                value={event.statusCode === null ? "—" : `${event.statusCode}`}
              />
              <Field
                label="Duration"
                value={
                  event.durationMs === null ? "—" : `${event.durationMs} ms`
                }
              />
              {CORRELATIONS.map((key) => (
                <Field key={key} label={key} value={event[key] ?? "—"} />
              ))}
            </div>
            <div className="overflow-x-auto">
              <pre className="bg-subtle text-text-2 m-0 rounded p-3 text-[12px]">
                {JSON.stringify(event.details, null, 2)}
              </pre>
            </div>
            {event.hasRequestBody || event.hasResponseBody ? (
              <div className="flex flex-wrap gap-2">
                {event.hasRequestBody ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setText("");
                      setOffset(0);
                      setPart("request");
                    }}
                  >
                    Show request body
                  </Button>
                ) : null}
                {event.hasResponseBody ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setText("");
                      setOffset(0);
                      setPart("response");
                    }}
                  >
                    Show response body
                  </Button>
                ) : null}
              </div>
            ) : null}
            {detail.error ? (
              <p className="text-text-3 m-0 text-[12px]">
                Bodies require membership in the event&apos;s project.
              </p>
            ) : null}
            {part !== "none" && body ? (
              <div className="flex flex-col gap-2">
                <div className="overflow-x-auto">
                  <pre className="bg-subtle text-text-2 m-0 rounded p-3 text-[12px] break-all whitespace-pre-wrap">
                    {shownText}
                  </pre>
                </div>
                {body.nextOffset === null ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setText(shownText);
                      setOffset(body.nextOffset!);
                    }}
                  >
                    Load more
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function EventsPanel() {
  const params = useSearchParams();
  return <EventsPanelContent key={params.toString()} />;
}

function EventsPanelContent() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const correlation = correlationFromParams(params);
  const [draft, setDraft] = useState<EventFilters>({
    ...DEFAULT_FILTERS,
    lookup: params.get("ref") ?? params.get("id") ?? "",
  });
  const [applied, setApplied] = useState<EventFilters>({
    ...DEFAULT_FILTERS,
    lookup: params.get("ref") ?? params.get("id") ?? "",
  });
  const [cursors, setCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [selectedId, setSelectedId] = useState<string | null>(
    params.get("id") ?? null,
  );
  const list = api.diagnostics.listEvents.useQuery(
    toListInput(applied, cursors.at(-1), correlation),
    {
      placeholderData: keepPreviousData,
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
    },
  );
  const set = (patch: Partial<EventFilters>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const clearCorrelation = (name: keyof CorrelationFilters) => {
    const next = new URLSearchParams(params.toString());
    next.delete(name);
    setCursors([undefined]);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };
  const items = list.data?.items ?? [];
  // A ?ref= link opens the newest matching event until the admin closes it.
  const [autoOpenReference, setAutoOpenReference] = useState(
    params.get("id") === null && params.get("ref") !== null,
  );
  const openId =
    selectedId ?? (autoOpenReference ? (items[0]?.id ?? null) : null);

  return (
    <Card id="events">
      <CardHeader>
        <CardTitle>Events</CardTitle>
        <CardDescription>
          The newest events first. Open a row for its correlation ids, details,
          and captured bodies.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="events-severity">Severity</Label>
            <Select
              value={draft.severity}
              onValueChange={(value) =>
                set({
                  severity: value as EventFilters["severity"],
                })
              }
            >
              <SelectTrigger id="events-severity">
                <SelectValue placeholder="Info and above" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info-and-above">Info and above</SelectItem>
                <SelectItem value="all">All severities</SelectItem>
                <SelectItem value="debug">Debug</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warn">Warning</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="events-category">Category</Label>
            <Input
              id="events-category"
              value={draft.category}
              onChange={(e) => set({ category: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="events-event">Event</Label>
            <Input
              id="events-event"
              value={draft.event}
              onChange={(e) => set({ event: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="events-lookup">Reference or id</Label>
            <Input
              id="events-lookup"
              value={draft.lookup}
              onChange={(e) => set({ lookup: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="events-since">From</Label>
            <Input
              id="events-since"
              type="datetime-local"
              value={draft.since}
              onChange={(e) => set({ since: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="events-until">To</Label>
            <Input
              id="events-until"
              type="datetime-local"
              value={draft.until}
              onChange={(e) => set({ until: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 lg:col-span-2">
            <Label htmlFor="events-text">Message contains</Label>
            <Input
              id="events-text"
              value={draft.text}
              onChange={(e) => set({ text: e.target.value })}
            />
          </div>
        </div>
        {Object.keys(correlation).length ? (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {PROCESSING_CORRELATIONS.map((key) =>
              correlation[key] ? (
                <span
                  key={key}
                  className="border-line-faint flex items-center gap-2 rounded-full border px-2 py-0.5"
                >
                  <span className="font-mono">{`${key[0]!.toUpperCase()}${key.slice(1).replace("Id", "")} ${correlation[key]}`}</span>
                  <button
                    type="button"
                    className="text-brand-text underline-offset-2 hover:underline"
                    onClick={() => clearCorrelation(key)}
                  >
                    {`Clear ${key.replace("Id", "")}`}
                  </button>
                </span>
              ) : null,
            )}
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setApplied(draft);
              setCursors([undefined]);
            }}
          >
            Apply
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setDraft(DEFAULT_FILTERS);
              setApplied(DEFAULT_FILTERS);
              setCursors([undefined]);
            }}
          >
            Clear
          </Button>
        </div>
        {list.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : list.error ? (
          <div
            role="alert"
            className="border-danger-border bg-danger-bg flex flex-col items-start gap-3 rounded-xl border p-4"
          >
            <p className="text-danger m-0 text-[13px]">
              Could not load events.
            </p>
            <Button variant="outline" onClick={() => void list.refetch()}>
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-text-3 m-0 text-[13px]">
            No events match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead className="w-full">Message</TableHead>
                  <TableHead>Runtime</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell title={row.createdAt.toISOString()}>
                      <button
                        type="button"
                        className="underline-offset-2 hover:underline"
                        aria-label={`Open event ${row.id.slice(0, 8)}`}
                        onClick={() => setSelectedId(row.id)}
                      >
                        <ClientDateTime value={row.createdAt} />
                      </button>
                    </TableCell>
                    <TableCell className={SEVERITY_TONE[row.severity]}>
                      {row.severity}
                    </TableCell>
                    <TableCell className="font-mono text-[12px]">
                      {row.category} · {row.event}
                    </TableCell>
                    <TableCell className="w-full max-w-0 truncate">
                      {row.message}
                    </TableCell>
                    <TableCell>{row.runtime}</TableCell>
                    <TableCell>{row.outcome ?? "—"}</TableCell>
                    <TableCell>
                      {row.durationMs === null ? "—" : `${row.durationMs} ms`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-text-3 m-0 text-[13px]">
            Page {cursors.length} · {items.length} events shown
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={cursors.length <= 1 || list.isFetching}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={
                !list.data?.nextCursor ||
                list.isFetching ||
                list.isPlaceholderData
              }
              onClick={() => {
                const next = list.data?.nextCursor;
                if (next) setCursors((current) => [...current, next]);
              }}
            >
              Next
            </Button>
          </div>
        </div>
        <EventDetailDialog
          id={openId}
          onClose={() => {
            setAutoOpenReference(false);
            setSelectedId(null);
          }}
        />
      </CardContent>
    </Card>
  );
}
