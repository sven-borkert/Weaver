"use client";

import { FileText, Paperclip } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { projectRoleAtLeast } from "@weaver/core/roles";
import type { WikiInputView } from "@weaver/core/services/wikiInputs";
import { WIKI_NOTE_MAX_CHARS } from "@weaver/core/wiki/states";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import {
  dataUnlessAccessError,
  isQueryAccessError,
} from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { formatBytes } from "../../imports/_components/upload";
import { uploadInputFiles } from "./uploadInputFiles";
import {
  WIKI_INPUT_ACCEPT,
  wikiActiveRunLabel,
  wikiHitLabel,
  wikiProcessCount,
  wikiRunNotice,
  wikiStatusLabel,
} from "./wikiInputPresentation";

const ACTIVE_POLL_MS = 5_000;

type PendingAction =
  | { kind: "remove"; item: WikiInputView }
  | { kind: "confirm"; item: WikiInputView }
  | { kind: "unlink"; item: WikiInputView };

function Row({
  item,
  selected,
  onSelect,
  actions,
}: {
  item: WikiInputView;
  selected?: boolean;
  onSelect?: (next: boolean) => void;
  actions?: React.ReactNode;
}) {
  const Icon = item.kind === "text" ? FileText : Paperclip;
  return (
    <li className="border-line flex flex-col gap-1 border-b px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-3">
        {onSelect ? (
          <input
            type="checkbox"
            aria-label={`Select ${item.title}`}
            checked={selected ?? false}
            onChange={(event) => onSelect(event.target.checked)}
          />
        ) : null}
        <Icon className="text-text-3 size-4 shrink-0" aria-hidden="true" />
        <span className="text-text min-w-0 flex-1 truncate text-[13px]">
          {item.title}
        </span>
        <span className="text-text-3 text-[12px] whitespace-nowrap">
          {item.kind === "text" ? "note" : "file"} ·{" "}
          {formatBytes(item.byteSize)} ·{" "}
          {item.mine ? "you" : (item.createdBy ?? "unknown")}
        </span>
        <span className="text-text-2 text-[12px] whitespace-nowrap">
          {wikiStatusLabel(item.status)}
        </span>
        {actions}
      </div>
      {item.errorMessage ? (
        <p className="text-danger m-0 text-[12px]">{item.errorMessage}</p>
      ) : null}
      {item.outcomeNote ? (
        <p className="text-text-3 m-0 text-[12px]">{item.outcomeNote}</p>
      ) : null}
      {item.heldHits?.length ? (
        <p className="text-danger m-0 text-[12px]">
          Looks like: {item.heldHits.map(wikiHitLabel).join(", ")}
        </p>
      ) : null}
    </li>
  );
}

export function WikiInputScreen({
  projectId,
  maxBytes,
}: {
  projectId: string;
  maxBytes: number;
}) {
  const utils = api.useUtils();
  const projectQuery = api.project.get.useQuery({ projectId });
  const project = dataUnlessAccessError(projectQuery.data, projectQuery.error);
  const list = api.wiki.input.list.useQuery(
    { projectId },
    {
      refetchInterval: (query) =>
        query.state.data?.activeRun ? ACTIVE_POLL_MS : false,
    },
  );
  const data = dataUnlessAccessError(list.data, list.error);
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => utils.wiki.input.list.invalidate({ projectId });
  const onError = (error: { message: string }) =>
    toast.error(error.message || "Could not update the wiki input");

  const addText = api.wiki.input.addText.useMutation({
    onSuccess: async () => {
      toast.success("Added to the queue");
      setNote("");
      await refresh();
    },
    onError,
  });
  const addFiles = api.wiki.input.addFiles.useMutation({ onError });
  const processItems = api.wiki.input.process.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.remaining > 0
          ? `Processing ${result.selected}; ${result.remaining} stay queued`
          : `Processing ${result.selected}`,
      );
      setSelected(new Set());
      await refresh();
    },
    onError,
  });
  const retry = api.wiki.input.retry.useMutation({
    onSuccess: refresh,
    onError,
  });
  const confirm = api.wiki.input.confirm.useMutation({
    onSuccess: async () => {
      setPending(null);
      await refresh();
    },
    onError,
  });
  const remove = api.wiki.input.remove.useMutation({
    onSuccess: async () => {
      setPending(null);
      await refresh();
    },
    onError,
  });
  const unlink = api.wiki.input.unlinkArtifact.useMutation({
    onSuccess: async () => {
      setPending(null);
      await refresh();
    },
    onError,
  });
  const cancelRun = api.wiki.cancelRun.useMutation({
    onSuccess: refresh,
    onError,
  });

  if (isQueryAccessError(list.error) || isQueryAccessError(projectQuery.error))
    return (
      <p className="text-text-2 p-6 text-[13px]">
        You do not have access to this project.
      </p>
    );

  const role = project?.myRole ?? "Viewer";
  const canEdit = projectRoleAtLeast(role, "Editor");
  const isOwner = role === "Owner";
  const enabled = project?.wikiEnabled === true;
  const queue = data?.queue ?? [];
  const attention = data?.attention ?? [];
  const recent = data?.recent ?? [];
  const queued = queue.filter((item) => item.status === "queued");
  const liveSelected = queued.filter((item) => selected.has(item.id));
  const counts = wikiProcessCount(
    queued.length,
    liveSelected.length,
    data?.batchLimit ?? 10,
  );
  const notice = data?.activeRun ? null : wikiRunNotice(data?.lastRun ?? null);
  const busy = processItems.isPending || Boolean(data?.activeRun);

  async function addSelectedFiles(files: File[]) {
    if (files.length === 0) return;
    const tooBig = files.find((file) => file.size > maxBytes);
    if (tooBig) {
      toast.error(`${tooBig.name} is larger than ${formatBytes(maxBytes)}`);
      return;
    }
    setUploading(true);
    try {
      const uploaded = await uploadInputFiles(projectId, files);
      if (uploaded.ids.length > 0)
        await addFiles.mutateAsync({ projectId, artifactIds: uploaded.ids });
      if (uploaded.kind === "error") toast.error(uploaded.message);
      else toast.success("Added to the queue");
      await refresh();
    } catch {
      // addFiles reports through its own onError; the upload stays in Files.
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function runPending() {
    if (!pending) return;
    const input = { projectId, itemId: pending.item.id };
    if (pending.kind === "remove") remove.mutate(input);
    if (pending.kind === "unlink") unlink.mutate(input);
    if (pending.kind === "confirm" && pending.item.heldDigest)
      confirm.mutate({ ...input, expectedDigest: pending.item.heldDigest });
  }
  const pendingBusy = remove.isPending || confirm.isPending || unlink.isPending;

  const removeButton = (item: WikiInputView) =>
    canEdit && item.status !== "processing" ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setPending({ kind: "remove", item })}
      >
        Remove
      </Button>
    ) : null;
  const unlinkButton = (item: WikiInputView) =>
    isOwner && item.kind === "file" ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setPending({ kind: "unlink", item })}
      >
        Unlink file
      </Button>
    ) : null;

  return (
    <div className="flex max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[18px] font-semibold">Wiki input</h1>
        <p className="text-text-2 m-0 text-[13px]">
          Inputs become permanent project history, are pushed to any configured
          Git remote, and are sent to the configured model provider. Do not add
          secrets.
        </p>
      </header>

      {!enabled && project ? (
        <p className="text-text-2 m-0 text-[13px]">
          The wiki is not enabled for this project. An Owner can enable it in
          Settings.
        </p>
      ) : null}

      {canEdit && enabled ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="wiki-note" className="text-text text-[13px]">
              Add a note
            </label>
            <Textarea
              id="wiki-note"
              rows={5}
              value={note}
              maxLength={WIKI_NOTE_MAX_CHARS}
              placeholder={`Markdown text (up to ${WIKI_NOTE_MAX_CHARS.toLocaleString("en-US")} characters)`}
              onChange={(event) => setNote(event.target.value)}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={addText.isPending || note.trim().length === 0}
                onClick={() => addText.mutate({ projectId, text: note })}
              >
                Add to queue
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              id="wiki-files"
              accept={WIKI_INPUT_ACCEPT}
              onChange={(event) =>
                void addSelectedFiles([...(event.target.files ?? [])])
              }
            />
            <Button
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? "Uploading…" : "Browse files"}
            </Button>
            <span className="text-text-3 text-[12px]">
              PDF, Word (docx), Excel (xlsx), CSV, Markdown, text · one file per
              item
            </span>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2" aria-label="Queue">
        <div className="flex items-center gap-2">
          <h2 className="text-text m-0 flex-1 text-[14px] font-semibold">
            Queue ({queue.length})
          </h2>
          {data?.activeRun ? (
            <>
              <span className="text-text-2 text-[12px]" role="status">
                {wikiActiveRunLabel(data.activeRun)}
              </span>
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancelRun.isPending}
                  onClick={() =>
                    cancelRun.mutate({ projectId, runId: data.activeRun!.id })
                  }
                >
                  Cancel run
                </Button>
              ) : null}
            </>
          ) : null}
          {canEdit && enabled ? (
            <Button
              size="sm"
              disabled={busy || queued.length === 0}
              onClick={() =>
                processItems.mutate({
                  projectId,
                  itemIds:
                    liveSelected.length > 0
                      ? liveSelected.map((item) => item.id)
                      : "all",
                })
              }
            >
              {liveSelected.length > 0
                ? `Process ${counts.take} selected`
                : `Process ${counts.take}`}
            </Button>
          ) : null}
        </div>
        {counts.left > 0 && !data?.activeRun ? (
          <p className="text-text-3 m-0 text-[12px]">
            {counts.left} more stay queued; a run takes up to{" "}
            {data?.batchLimit ?? 10}.
          </p>
        ) : null}
        {queue.length === 0 ? (
          <p className="text-text-3 m-0 text-[13px]">Nothing is queued.</p>
        ) : (
          <ul className="border-line m-0 list-none rounded border p-0">
            {queue.map((item) => (
              <Row
                key={item.id}
                item={item}
                {...(canEdit && item.status === "queued"
                  ? {
                      selected: selected.has(item.id),
                      onSelect: (next: boolean) =>
                        setSelected((current) => {
                          const copy = new Set(current);
                          if (next) copy.add(item.id);
                          else copy.delete(item.id);
                          return copy;
                        }),
                    }
                  : {})}
                actions={
                  <>
                    {unlinkButton(item)}
                    {removeButton(item)}
                  </>
                }
              />
            ))}
          </ul>
        )}
      </section>

      {notice ? (
        <p
          role="status"
          className={
            notice.tone === "warn"
              ? "text-danger m-0 text-[13px]"
              : "text-text-2 m-0 text-[13px]"
          }
        >
          {notice.message}
        </p>
      ) : null}

      {attention.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Needs attention">
          <h2 className="text-text m-0 text-[14px] font-semibold">
            Needs attention ({attention.length})
          </h2>
          <ul className="border-line m-0 list-none rounded border p-0">
            {attention.map((item) => (
              <Row
                key={item.id}
                item={item}
                actions={
                  canEdit ? (
                    <>
                      {item.status === "held" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPending({ kind: "confirm", item })}
                        >
                          Confirm
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={retry.isPending}
                          onClick={() =>
                            retry.mutate({ projectId, itemId: item.id })
                          }
                        >
                          Retry
                        </Button>
                      )}
                      {unlinkButton(item)}
                      {removeButton(item)}
                    </>
                  ) : null
                }
              />
            ))}
          </ul>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <details>
          <summary className="text-text cursor-pointer text-[14px] font-semibold">
            Recently processed (7 days)
          </summary>
          <ul className="border-line mt-2 list-none rounded border p-0">
            {recent.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
        </details>
      ) : null}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !pendingBusy) setPending(null);
        }}
      >
        <DialogContent aria-busy={pendingBusy}>
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "remove"
                ? "Remove this input?"
                : pending?.kind === "unlink"
                  ? "Unlink this file?"
                  : "Send this input anyway?"}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === "remove"
                ? "Its text and any parsed draft are cleared. A source page already written stays in the project."
                : pending?.kind === "unlink"
                  ? "The file in Files can then be replaced or deleted. Any source page already written stays."
                  : "This content will become permanent project history, go to any configured Git remote and to the model provider. Confirm only if the finding is wrong or the value is not sensitive."}
            </DialogDescription>
          </DialogHeader>
          {pending?.kind === "confirm" && pending.item.heldHits?.length ? (
            <ul className="text-text-2 m-0 list-disc pl-5 text-[13px]">
              {pending.item.heldHits.map((hit) => (
                <li key={`${hit.kind}:${hit.location}`}>{wikiHitLabel(hit)}</li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pendingBusy}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button disabled={pendingBusy} onClick={runPending}>
              {pending?.kind === "remove"
                ? "Remove"
                : pending?.kind === "unlink"
                  ? "Unlink"
                  : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
