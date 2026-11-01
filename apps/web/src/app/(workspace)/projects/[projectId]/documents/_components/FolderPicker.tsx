"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { folderPathLabel } from "~/lib/explorer/entries";

export const decodeFolderValue = (value: string): string[] =>
  value === "/" ? [] : value.split("/").filter(Boolean);

function encodeFolderValue(path: string[]): string {
  return path.length ? path.join("/") : "/";
}

function folderLabel(
  path: string,
  folderNames: Record<string, string> | undefined,
): string {
  if (path === "/") return "Project root";
  const segments = decodeFolderValue(path);
  return `${"\u00a0\u00a0".repeat(Math.max(0, segments.length - 1))}${folderPathLabel(folderNames, segments)}`;
}

type FolderPickerProps = {
  folders: string[];
  folderNames?: Record<string, string>;
  value: string[];
  onValueChange: (path: string[]) => void;
  excludeSubtree?: string[];
  disabled?: boolean;
};

export function FolderPicker({
  folders,
  folderNames,
  value,
  onValueChange,
  excludeSubtree,
  disabled = false,
}: FolderPickerProps) {
  const excluded = excludeSubtree?.length
    ? excludeSubtree.join("/")
    : undefined;
  const options = ["/", ...folders].filter(
    (candidate) =>
      !excluded ||
      (candidate !== excluded && !candidate.startsWith(`${excluded}/`)),
  );

  return (
    <Select
      value={encodeFolderValue(value)}
      disabled={disabled}
      onValueChange={(nextValue) => onValueChange(decodeFolderValue(nextValue))}
    >
      <SelectTrigger aria-label="Folder">
        <SelectValue placeholder="Select a folder" />
      </SelectTrigger>
      <SelectContent>
        {options.map((folder) => (
          <SelectItem key={folder} value={folder}>
            {folderLabel(folder, folderNames)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
