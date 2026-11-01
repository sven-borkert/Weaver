import { iconAssetPath, isIconAssetPath } from "@weaver/core/appearance/icons";
import type { Appearance } from "@weaver/core/appearance/metadata";
import {
  parseFolderMetadata,
  type FolderMetadata,
} from "@weaver/core/documents/folderMetadata";
import { sniffImageType, imageExtension } from "@weaver/core/documents/images";
import { documentKindFromFileName } from "@weaver/core/documents/kinds";
import { analyzeZipEntries } from "./zip-import";
import type { ZipEntryInfo } from "./zip-import";

export type OpenedZip = {
  entries: ZipEntryInfo[];
  text: (path: string) => Promise<string>;
  blob: (path: string) => Promise<Blob>;
};

// JSZip keeps the central-directory size on a private field; there is no public accessor.
type SizedEntry = { _data?: { uncompressedSize?: number } };

/** Opens a ZIP without inflating it; entries are read one at a time on demand. */
export async function openZip(data: ArrayBuffer): Promise<OpenedZip> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  for (const file of Object.values(zip.files)) {
    if (file.unsafeOriginalName && file.unsafeOriginalName !== file.name)
      throw new Error("Unsafe ZIP path");
  }
  const entry = (path: string) => {
    const found = zip.file(path);
    if (!found) throw new Error(`missing ZIP entry: ${path}`);
    return found;
  };
  const read = (path: string): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const file = entry(path);
      const declared =
        (file as unknown as SizedEntry)._data?.uncompressedSize ?? 0;
      const cap = isIconAssetPath(path)
        ? 2 * 1024 * 1024
        : path.endsWith(".folder.json")
          ? 65536
          : documentKindFromFileName(path) !== null
            ? 800000
            : 64 * 1024 * 1024;
      if (declared > cap) {
        reject(new Error("ZIP entry exceeds the import size limit"));
        return;
      }
      let length = 0;
      const parts: Uint8Array[] = [];
      type Stream = {
        on(event: "data", callback: (chunk: Uint8Array) => void): Stream;
        on(event: "error", callback: (error: Error) => void): Stream;
        on(event: "end", callback: () => void): Stream;
        pause(): Stream;
        resume(): Stream;
      };
      const stream = (
        file as unknown as { internalStream(type: "uint8array"): Stream }
      ).internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          length += chunk.byteLength;
          if (length > cap || length > declared) {
            stream.pause();
            reject(new Error("ZIP entry exceeds its size limit"));
          } else parts.push(chunk);
        })
        .on("error", reject)
        .on("end", () => {
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
          }
          resolve(bytes.buffer);
        })
        .resume();
    });
  return {
    entries: Object.values(zip.files).map((file) => ({
      path: file.name,
      size: file.dir
        ? 0
        : ((file as unknown as SizedEntry)._data?.uncompressedSize ?? 0),
      dir: file.dir,
    })),
    text: async (path) => new TextDecoder().decode(await read(path)),
    blob: async (path) => new Blob([await read(path)]),
  };
}

export type ZipAppearanceMetadata = {
  folders: Record<string, FolderMetadata>;
  icons: Map<string, Blob>;
};

export async function readZipAppearance(
  zip: OpenedZip,
): Promise<ZipAppearanceMetadata> {
  const analysis = analyzeZipEntries(zip.entries);
  if (!analysis.ok) throw new Error(analysis.error);
  const folders: Record<string, FolderMetadata> = {};
  const icons = new Map<string, Blob>();
  for (const path of analysis.folderEntries) {
    const metadata = parseFolderMetadata(await zip.text(path));
    if (!metadata) throw new Error("Invalid folder metadata");
    folders[path.slice(0, -"/.folder.json".length)] = metadata;
  }
  for (const path of analysis.iconEntries) {
    const blob = await zip.blob(path);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = sniffImageType(bytes.subarray(0, 16));
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (
      !type ||
      type === "image/gif" ||
      path !== `.weaver-icons/${digest}.${imageExtension(type)}`
    )
      throw new Error("Invalid icon image or digest");
    icons.set(path, blob);
  }
  return { folders, icons };
}

export function zipIconParts(
  appearances: Array<Appearance | undefined>,
  icons: Map<string, Blob>,
): Array<{ name: string; blob: Blob }> {
  const parts = new Map<string, Blob>();
  for (const appearance of appearances) {
    const icon = appearance?.icon;
    if (icon?.type !== "image") continue;
    const path = iconAssetPath(icon);
    const blob = icons.get(path);
    if (!blob) throw new Error("Referenced icon image is missing from the ZIP");
    parts.set(path.slice(".weaver-icons/".length), blob);
  }
  return [...parts].map(([name, blob]) => ({ name, blob }));
}
