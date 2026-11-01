"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { folderPathLabel } from "~/lib/explorer/entries";

const decodeFolderValue = (value: string): string[] =>
  value === "/" ? [] : value.split("/").filter(Boolean);

const encodeFolderValue = (path: string[]): string =>
  path.length ? path.join("/") : "/";

function folderLabel(
  path: string,
  folderNames: Record<string, string> | undefined,
): string {
  if (path === "/") return "Tables root";
  const segments = decodeFolderValue(path);
  return `${"\u00a0\u00a0".repeat(Math.max(0, segments.length - 1))}${folderPathLabel(folderNames, segments)}`;
}

type TableFolderPickerProps = {
  id?: string;
  folders: string[];
  folderNames?: Record<string, string>;
  value: string[];
  onValueChange: (path: string[]) => void;
  excludeSubtree?: string[];
  disabled?: boolean;
  label?: string;
};

export function TableFolderPicker({
  id,
  folders,
  folderNames,
  value,
  onValueChange,
  excludeSubtree,
  disabled = false,
  label = "Folder",
}: TableFolderPickerProps) {
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
      <SelectTrigger id={id} aria-label={label}>
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
