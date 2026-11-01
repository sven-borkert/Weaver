import { Readable } from "node:stream";
import JSZip from "jszip";

import type { ArchiveBlob, ArchivePlan } from "@weaver/core/documents/archive";

function safeArchivePath(path: string): string {
  if (
    /[\\:\p{Cc}]/u.test(path) ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("Unsafe archive path");
  return path;
}

/** Streams a ZIP of the plan; each blob is read only when the archive reaches it. */
export function createArchiveStream(input: {
  /** Wrapper directory; without one the files sit at the archive root. */
  rootName?: string;
  plan: ArchivePlan;
  date: Date;
  readBlob: (file: ArchiveBlob) => Promise<Buffer>;
}): Readable {
  const zip = new JSZip();
  const { plan, date, readBlob } = input;
  const prefix = input.rootName ? `${safeArchivePath(input.rootName)}/` : "";
  if (prefix) zip.file(prefix, null, { dir: true, date });
  for (const directory of plan.directories)
    zip.file(
      `${safeArchivePath(`${prefix}${safeArchivePath(directory)}`)}/`,
      null,
      { dir: true, date },
    );
  for (const file of plan.files) {
    zip.file(
      safeArchivePath(
        `${file.archiveRoot ? "" : prefix}${safeArchivePath(file.path)}`,
      ),
      Readable.from(
        (async function* () {
          yield file.bytes ? Buffer.from(file.bytes) : await readBlob(file);
        })(),
        { objectMode: false },
      ),
      { date, createFolders: true },
    );
  }
  const source = zip.generateInternalStream({
    type: "nodebuffer",
    streamFiles: true,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  // JSZip's own Node stream is a legacy stream: no async iteration, no toWeb.
  const archive = new Readable({
    read() {
      source.resume();
    },
    destroy(error, callback) {
      source.pause();
      callback(error);
    },
  });
  source
    .on("data", (chunk) => {
      if (!archive.push(chunk)) source.pause();
    })
    .on("end", () => archive.push(null))
    .on("error", (error) => archive.destroy(error));
  return archive;
}
