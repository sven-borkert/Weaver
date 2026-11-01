export const CSV_EXTENSIONS = [".csv", ".tsv"] as const;

export function isCsvFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return CSV_EXTENSIONS.some(
    (ext) => lower.endsWith(ext) && lower.length > ext.length,
  );
}

export function partitionDroppedCsvFiles(files: File[]): {
  csv: File[];
  ignored: File[];
} {
  const csv: File[] = [];
  const ignored: File[] = [];
  for (const file of files)
    (isCsvFileName(file.name) ? csv : ignored).push(file);
  return { csv, ignored };
}
