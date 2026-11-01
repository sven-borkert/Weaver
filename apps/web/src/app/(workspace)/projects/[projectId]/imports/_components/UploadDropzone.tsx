"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_INGESTION_UPLOAD_FILES } from "@weaver/core/ingestion/limits";
import { Button } from "~/components/ui/button";
import { formatBytes, UPLOAD_ACCEPT, uploadFiles } from "./upload";

export function UploadDropzone({
  projectId,
  maxBytes,
  onUploaded,
  onAccessDenied,
}: {
  projectId: string;
  maxBytes: number;
  onUploaded: (batchId: string) => Promise<void>;
  onAccessDenied: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => () => controller.current?.abort(), []);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  async function upload(files: File[]) {
    if (busyRef.current) {
      setNotice(
        "An upload is already running. Wait for it to finish or cancel it before selecting more files.",
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setProgress(0);
    controller.current = new AbortController();
    setNotice("");
    try {
      if (!files.length) return;
      const result = await uploadFiles(
        projectId,
        files,
        maxBytes,
        fetch,
        undefined,
        { signal: controller.current.signal, onProgress: setProgress },
      );
      if (result.kind === "error") {
        setNotice(result.message);
        toast.error(result.message);
        if (result.accessDenied) onAccessDenied();
        return;
      }
      const message =
        result.kind === "pending"
          ? "Files are stored. Processing is pending and will resume automatically. You do not need to upload them again."
          : "Files uploaded. Processing will update below.";
      setNotice(message);
      if (result.kind === "pending") toast.info(message);
      else toast.success("Files uploaded");
      await onUploaded(result.batchId);
    } catch {
      setNotice(
        "Files may be stored. Refresh the batch list before trying again.",
      );
      toast.error(
        "Could not refresh imports. Refresh the page to check your files.",
      );
    } finally {
      controller.current = null;
      busyRef.current = false;
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }
  return (
    <section aria-label="Upload files" className="flex flex-col gap-2">
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
          void upload([...event.dataTransfer.files]);
        }}
        className={`bg-surface rounded-[10px] border border-dashed p-6 text-center ${dragging ? "border-brand" : "border-line-strong"}`}
      >
        <p className="text-text-2 mb-3 text-sm">
          {busy
            ? progress === 100
              ? "Files sent. Finishing upload…"
              : `Uploading… ${progress}%`
            : "Drop files here or choose files to upload"}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={busy}
          accept={UPLOAD_ACCEPT}
          className="sr-only"
          aria-label="Choose files to import"
          onChange={(event) => void upload([...(event.target.files ?? [])])}
        />
        <Button
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
        <p className="text-text-3 mt-3 mb-0 text-xs">
          Up to {MAX_INGESTION_UPLOAD_FILES} files, {formatBytes(maxBytes)}{" "}
          each.
        </p>
      </div>
      {notice ? (
        <p role="status" className="text-text-2 m-0 text-sm">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
