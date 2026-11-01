"use client";

import { importedAppearance } from "@weaver/core/documents/importMarkdown";
import { splitPythonImport } from "@weaver/core/documents/importPython";
import type { FolderMetadata } from "@weaver/core/documents/folderMetadata";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { invalidateDocumentReferenceCaches } from "~/lib/documents/document-cache-invalidation";
import {
  analyzeZipEntries,
  describeZipDocument,
  findCollision,
  planImportTarget,
  type ZipDocument,
  type ZipDocumentDetails,
  type ZipSkipped,
} from "~/lib/documents/zip-import";
import {
  openZip,
  readZipAppearance,
  zipIconParts,
  type ZipAppearanceMetadata,
  type OpenedZip,
} from "~/lib/documents/zip-import-read";
import {
  uploadArchiveDocument,
  uploadArchiveFolders,
} from "~/lib/documents/zip-import-upload";
import { api } from "~/trpc/react";

type Decision = "skip" | "copy" | "replace";
type Row = { doc: ZipDocument; details: ZipDocumentDetails };
type Summary = {
  folders: number;
  imported: number;
  replaced: number;
  skipped: number;
  failed: string[];
};
type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "preview";
      zip: OpenedZip;
      rows: Row[];
      skipped: ZipSkipped[];
      appearance: ZipAppearanceMetadata;
    }
  | { kind: "importing"; done: number; total: number }
  | { kind: "done"; summary: Summary };

const DECISIONS: Array<{ value: Decision; label: string }> = [
  { value: "skip", label: "Skip" },
  { value: "copy", label: "Import as copy" },
  { value: "replace", label: "Replace" },
];

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

async function readZip(file: File): Promise<Phase> {
  let zip: OpenedZip;
  try {
    zip = await openZip(await file.arrayBuffer());
  } catch {
    return { kind: "error", message: "This file is not a readable ZIP." };
  }
  const analysis = analyzeZipEntries(zip.entries);
  if (!analysis.ok) return { kind: "error", message: analysis.error };
  const rows: Row[] = [];
  for (const doc of analysis.documents)
    rows.push({
      doc,
      details: describeZipDocument(doc, await zip.text(doc.entryPath)),
    });
  const appearance = await readZipAppearance(zip);
  return { kind: "preview", zip, rows, skipped: analysis.skipped, appearance };
}

export function ImportZipDialog({
  projectId,
  folderPath,
  file,
  onClose,
}: {
  projectId: string;
  folderPath: string[];
  file: File;
  onClose: () => void;
}) {
  const utils = api.useUtils();
  const tree = api.folder.tree.useQuery({ projectId });
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [keepStructure, setKeepStructure] = useState(true);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readZip(file)
      .catch((error: unknown): Phase => ({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not read ZIP",
      }))
      .then((next) => {
        if (!cancelled) setPhase(next);
      });
    return () => {
      cancelled = true;
      abort.current?.abort();
    };
  }, [file]);

  const rows = phase.kind === "preview" ? phase.rows : null;
  const emptyFolders =
    phase.kind === "preview"
      ? Object.keys(phase.appearance.folders).filter(
          (path) =>
            !phase.rows.some((row) => row.doc.entryPath.startsWith(`${path}/`)),
        )
      : [];
  const hasFolders =
    emptyFolders.length > 0 ||
    rows?.some((row) => row.doc.directories.length > 0);
  const existing = tree.data?.documents;
  const planned = useMemo(
    () =>
      (rows ?? []).map((row) => {
        const target = planImportTarget(
          row.doc.directories,
          folderPath,
          keepStructure,
        );
        const collision =
          target.ok && existing
            ? findCollision(
                {
                  weaverId: row.details.weaverId,
                  title: row.details.title,
                  folderPath: target.folderPath,
                  documentKind: row.doc.kind,
                },
                existing,
              )
            : null;
        const blocked =
          row.details.problem ?? (target.ok ? null : target.reason);
        return { ...row, target, collision, blocked };
      }),
    [rows, folderPath, keepStructure, existing],
  );
  const collisions = planned.filter((row) => row.collision && !row.blocked);
  const decisionFor = (entryPath: string): Decision =>
    decisions[entryPath] ?? "skip";
  const importable = planned.filter(
    (row) =>
      !row.blocked &&
      (!row.collision || decisionFor(row.doc.entryPath) !== "skip"),
  );

  const run = async () => {
    if (phase.kind !== "preview") return;
    const { zip, appearance } = phase;
    const metadataFor = (
      directories: string[],
    ): Record<string, FolderMetadata> => {
      if (!keepStructure) return {};
      const metadata: Record<string, FolderMetadata> = {};
      for (let depth = 1; depth <= directories.length; depth++) {
        const sourcePath = directories.slice(0, depth).join("/");
        const source = appearance.folders[sourcePath];
        if (!source) continue;
        const target = planImportTarget(
          directories.slice(0, depth),
          folderPath,
          true,
        );
        if (!target.ok) throw new Error(target.reason);
        metadata[target.folderPath.join("/")] = source;
      }
      return metadata;
    };
    const controller = new AbortController();
    abort.current = controller;
    const summary: Summary = {
      folders: 0,
      imported: 0,
      replaced: 0,
      skipped: planned.length - importable.length,
      failed: [],
    };
    const folderTotal = keepStructure ? emptyFolders.length : 0;
    const total = importable.length + folderTotal;
    setPhase({ kind: "importing", done: 0, total });
    if (keepStructure)
      for (const [index, path] of emptyFolders.entries()) {
        if (controller.signal.aborted) break;
        try {
          const folderMetadata = metadataFor(path.split("/"));
          await uploadArchiveFolders({
            projectId,
            folderPath,
            folderMetadata,
            icons: zipIconParts(
              Object.values(folderMetadata).map((meta) => meta.appearance),
              appearance.icons,
            ),
            signal: controller.signal,
          });
          summary.folders += 1;
        } catch (error) {
          summary.failed.push(
            `${path} (${error instanceof Error ? error.message : "failed"})`,
          );
        }
        setPhase({ kind: "importing", done: index + 1, total });
      }
    for (const [index, row] of importable.entries()) {
      if (controller.signal.aborted) break;
      const replaced =
        row.collision && decisionFor(row.doc.entryPath) === "replace"
          ? row.collision.existing
          : null;
      try {
        if (!row.target.ok) throw new Error(row.target.reason);
        const text = await zip.text(row.doc.entryPath);
        const folderMetadata = replaced ? {} : metadataFor(row.doc.directories);
        const icons = replaced
          ? []
          : zipIconParts(
              [
                row.doc.kind === "python"
                  ? splitPythonImport(text, row.doc.fileName).appearance
                  : importedAppearance(text),
                ...Object.values(folderMetadata).map((meta) => meta.appearance),
              ],
              appearance.icons,
            );
        await uploadArchiveDocument({
          projectId,
          folderPath: row.target.folderPath,
          folderNames: row.target.folderNames,
          kind: row.doc.kind,
          fileName: row.doc.fileName,
          text,
          folderMetadata,
          icons,
          images: await Promise.all(
            row.doc.images.map(async (image) => ({
              name: image.name,
              blob: await zip.blob(image.entryPath),
            })),
          ),
          target: replaced
            ? {
                mode: "replace",
                documentId: replaced.id,
                expectedHeadCommitSha: replaced.headCommitSha!,
              }
            : { mode: "create" },
          signal: controller.signal,
        });
        if (replaced) summary.replaced += 1;
        else summary.imported += 1;
      } catch (error) {
        if (controller.signal.aborted) break;
        summary.failed.push(
          `${row.doc.entryPath} (${error instanceof Error ? error.message : "failed"})`,
        );
      }
      setPhase({
        kind: "importing",
        done: folderTotal + index + 1,
        total,
      });
    }
    void utils.folder.tree.invalidate({ projectId });
    void utils.document.invalidate();
    void invalidateDocumentReferenceCaches(utils, projectId);
    if (!controller.signal.aborted) setPhase({ kind: "done", summary });
  };

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import {file.name}</DialogTitle>
          <DialogDescription>
            Review what the ZIP holds before anything is written.
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "loading" ? (
          <p role="status" className="text-text-2 text-[13px]">
            Reading the ZIP…
          </p>
        ) : null}

        {phase.kind === "error" ? (
          <p role="alert" className="text-danger text-[13px]">
            {phase.message}
          </p>
        ) : null}

        {phase.kind === "preview" ? (
          <div className="flex flex-col gap-4 text-[13px]">
            {planned.length === 0 && emptyFolders.length === 0 ? (
              <p className="m-0">This ZIP holds no documents.</p>
            ) : (
              <>
                {hasFolders ? (
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="text-text mb-1 p-0 font-medium">
                      Folders
                    </legend>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="zip-structure"
                        checked={keepStructure}
                        onChange={() => setKeepStructure(true)}
                      />
                      Keep folder structure (missing folders are created)
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="zip-structure"
                        checked={!keepStructure}
                        onChange={() => setKeepStructure(false)}
                      />
                      Import flat into this folder
                    </label>
                  </fieldset>
                ) : null}

                {emptyFolders.length > 0 && keepStructure ? (
                  <p className="m-0">
                    {plural(emptyFolders.length, "empty folder")} with metadata
                    will be imported.
                  </p>
                ) : null}
                <section aria-label="Documents" className="flex flex-col gap-1">
                  <h3 className="text-text m-0 text-[13px] font-medium">
                    {plural(planned.length, "document")}
                  </h3>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {planned.map((row) => (
                      <li key={row.doc.entryPath} className="flex flex-col">
                        <span className="text-text">
                          {row.details.title}
                          <span className="text-text-3">
                            {" · "}
                            {plural(row.doc.images.length, "image")}
                          </span>
                        </span>
                        <span className="text-text-3 break-all">
                          {row.doc.entryPath}
                          {row.target.ok && row.target.folderPath.length
                            ? ` → ${row.target.folderPath.join("/")}/`
                            : null}
                        </span>
                        {row.blocked ? (
                          <span className="text-danger">
                            Cannot be imported: {row.blocked}
                          </span>
                        ) : null}
                        {row.details.missingImages.length ? (
                          <span className="text-text-2">
                            Missing from the ZIP:{" "}
                            {row.details.missingImages.join(", ")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>

                {collisions.length ? (
                  <section
                    aria-label="Collisions"
                    className="flex flex-col gap-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-text m-0 text-[13px] font-medium">
                        {plural(collisions.length, "collision")}
                      </h3>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-text-3">Apply to all:</span>
                        {DECISIONS.map((option) => (
                          <Button
                            key={option.value}
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setDecisions(
                                Object.fromEntries(
                                  collisions
                                    .filter(
                                      (row) =>
                                        option.value !== "replace" ||
                                        row.collision!.replaceable,
                                    )
                                    .map((row) => [
                                      row.doc.entryPath,
                                      option.value,
                                    ]),
                                ),
                              )
                            }
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {collisions.map((row) => {
                        const id = `zip-decision-${row.doc.entryPath}`;
                        const {
                          kind,
                          existing: current,
                          replaceable,
                        } = row.collision!;
                        return (
                          <li
                            key={row.doc.entryPath}
                            className="flex flex-wrap items-center justify-between gap-2"
                          >
                            <Label
                              htmlFor={id}
                              className="flex flex-col items-start"
                            >
                              <span>{row.details.title}</span>
                              <span className="text-text-3 font-normal break-all">
                                {kind === "id"
                                  ? "Already in this project as "
                                  : "Same title as "}
                                “{current.title}” ({current.path})
                              </span>
                              {replaceable ? null : (
                                <span className="text-text-3 font-normal">
                                  Replace unavailable: different file kind
                                </span>
                              )}
                            </Label>
                            <Select
                              value={decisionFor(row.doc.entryPath)}
                              onValueChange={(value) =>
                                setDecisions((previous) => ({
                                  ...previous,
                                  [row.doc.entryPath]: value as Decision,
                                }))
                              }
                            >
                              <SelectTrigger id={id} className="w-44">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {DECISIONS.map((option) => (
                                  <SelectItem
                                    key={option.value}
                                    value={option.value}
                                    disabled={
                                      option.value === "replace" && !replaceable
                                    }
                                  >
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
              </>
            )}

            {phase.skipped.length ? (
              <details>
                <summary className="text-text-2 cursor-pointer">
                  Not imported: {plural(phase.skipped.length, "file")}
                </summary>
                <ul className="text-text-3 m-0 mt-1 flex list-none flex-col p-0">
                  {phase.skipped.map((entry) => (
                    <li key={entry.path} className="break-all">
                      {entry.path} — {entry.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}

        {phase.kind === "importing" ? (
          <p role="status" className="text-text-2 text-[13px]">
            Importing {phase.done} of {phase.total}…
          </p>
        ) : null}

        {phase.kind === "done" ? (
          <div role="status" className="flex flex-col gap-1 text-[13px]">
            <p className="m-0">
              Imported {phase.summary.imported} documents and{" "}
              {phase.summary.folders} folders, replaced {phase.summary.replaced}
              , skipped {phase.summary.skipped}, failed{" "}
              {phase.summary.failed.length}.
            </p>
            {phase.summary.failed.length ? (
              <ul className="text-danger m-0 flex list-none flex-col p-0">
                {phase.summary.failed.map((name) => (
                  <li key={name} className="break-all">
                    {name}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {phase.kind === "done" && phase.summary.failed.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPhase({ kind: "loading" });
                setDecisions({});
                void Promise.all([readZip(file), tree.refetch()])
                  .then(([preview]) => setPhase(preview))
                  .catch(() =>
                    setPhase({
                      kind: "error",
                      message: "Could not refresh import preview.",
                    }),
                  );
              }}
            >
              Preview again
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={close}>
            {phase.kind === "done" || phase.kind === "error"
              ? "Close"
              : "Cancel"}
          </Button>
          {phase.kind === "preview" &&
          (planned.length > 0 || emptyFolders.length > 0) ? (
            <Button
              type="button"
              disabled={
                (importable.length === 0 &&
                  (!keepStructure || emptyFolders.length === 0)) ||
                !tree.data
              }
              onClick={() => void run()}
            >
              Import {plural(importable.length, "document")}
              {keepStructure && emptyFolders.length
                ? ` and ${plural(emptyFolders.length, "empty folder")}`
                : ""}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
