"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_INGESTION_UPLOAD_FILES } from "@weaver/core/ingestion/limits";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { formatBytes } from "../../imports/_components/upload";
import {
  classifyArtifactBatch,
  mergeReplacements,
  planArtifactUpload,
  replaceConfirmTitle,
  uploadedMessage,
} from "./artifactBatch";
import { uploadArtifacts } from "./uploadArtifacts";

type Notice = { text: string; tone: "error" | "info" };

/** Live-region text changes only at 25 % steps so screen readers are not flooded. */
function uploadAnnouncement(busy: boolean, progress: number): string {
  if (!busy) return "";
  if (progress >= 100) return "Files sent. Finishing upload…";
  return `Uploading… ${Math.floor(progress / 25) * 25}%`;
}
/** A batch waiting for the replace confirmation, before or after a 409. */
type Pending = { files: File[]; replace: string[]; names: string[] };

export function ArtifactUpload({
  projectId,
  maxFileBytes,
  existingFilenames,
  onUploaded,
}: {
  projectId: string;
  maxFileBytes: number;
  existingFilenames: readonly string[];
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function clearInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  function select(files: File[]) {
    if (busyRef.current) {
      setNotice({
        text: "An upload is already running. Wait for it to finish or cancel it before selecting more files.",
        tone: "info",
      });
      clearInput();
      return;
    }
    setNotice(null);
    const plan = planArtifactUpload(
      classifyArtifactBatch(files, existingFilenames, maxFileBytes),
      maxFileBytes,
    );
    clearInput();
    if (plan.kind === "blocked") {
      setNotice({ text: plan.message, tone: "error" });
      return;
    }
    if (plan.kind === "confirm") {
      setPending({ files: plan.files, replace: [], names: plan.names });
      return;
    }
    void run(plan.files, []);
  }

  async function run(files: File[], replace: string[]) {
    busyRef.current = true;
    setBusy(true);
    setProgress(0);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await uploadArtifacts(projectId, files, replace, {
        signal: abort.signal,
        onProgress: setProgress,
      });
      if (abort.signal.aborted) {
        setNotice({ text: "Upload cancelled.", tone: "info" });
        onUploaded();
        return;
      }
      if (result.kind === "conflict") {
        setPending({
          files,
          replace,
          names: mergeReplacements(replace, result.conflicts),
        });
        return;
      }
      if (result.kind === "error") {
        setNotice({ text: result.message, tone: "error" });
        if (result.accessDenied) onUploaded();
        return;
      }
      setNotice(null);
      toast.success(uploadedMessage(result.count));
      onUploaded();
    } finally {
      controller.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }

  const confirmed = () => {
    if (!pending) return;
    const { files, replace, names } = pending;
    setPending(null);
    void run(files, mergeReplacements(replace, names));
  };

  return (
    <section
      ref={sectionRef}
      aria-label="Upload files"
      tabIndex={-1}
      className="flex flex-col gap-2 outline-none"
    >
      <div
        aria-busy={busy}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busyRef.current) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          // Dragged text or a link carries no files and is not a failed upload.
          const dropped = [...event.dataTransfer.files];
          if (dropped.length) select(dropped);
        }}
        className={`bg-surface flex flex-col items-center gap-3 rounded-[10px] border border-dashed p-6 text-center ${dragging ? "border-brand" : "border-line-strong"}`}
      >
        <p className="text-text-2 m-0 text-sm">
          {busy
            ? progress === 100
              ? "Files sent. Finishing upload…"
              : `Uploading… ${progress}%`
            : "Drop files here or choose files to upload"}
        </p>
        <span role="status" className="sr-only">
          {uploadAnnouncement(busy, progress)}
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={busy}
          className="sr-only"
          aria-label="Choose files to upload"
          onChange={(event) => select([...(event.target.files ?? [])])}
        />
        <div className="flex gap-2">
          <Button
            ref={chooseRef}
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            Choose files
          </Button>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => controller.current?.abort()}
            >
              Cancel upload
            </Button>
          ) : null}
        </div>
        <p className="text-text-3 m-0 text-xs">
          Up to {MAX_INGESTION_UPLOAD_FILES} files, {formatBytes(maxFileBytes)}{" "}
          each.
        </p>
      </div>
      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`m-0 text-sm ${notice.tone === "error" ? "text-danger" : "text-text-2"}`}
        >
          {notice.text}
        </p>
      ) : null}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusDialogTarget(chooseRef.current, sectionRef.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {replaceConfirmTitle(pending?.names.length ?? 0)}
            </DialogTitle>
            <DialogDescription>
              The current content of these files is overwritten and cannot be
              restored.
            </DialogDescription>
          </DialogHeader>
          <ul className="text-text m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
            {pending?.names.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmed}>
              Replace and upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
