const ROOT_LABEL = "project root";

function pathLabel(path: string | null): string {
  if (path === null) return "—";
  return path.length === 0 ? ROOT_LABEL : path;
}

function carriedLabel(affected: {
  documents: number;
  tables: number;
}): string | null {
  const parts: string[] = [];
  if (affected.documents > 0)
    parts.push(
      `${affected.documents.toLocaleString("en-US")} document${affected.documents === 1 ? "" : "s"}`,
    );
  if (affected.tables > 0)
    parts.push(
      `${affected.tables.toLocaleString("en-US")} table${affected.tables === 1 ? "" : "s"}`,
    );
  return parts.length > 0 ? parts.join(" and ") : null;
}

/**
 * What a reviewer has to see before approving an organization change: where it
 * comes from, where it goes, and how much rides along (concept §7.2). A folder
 * move carries everything beneath it, which is the part that is easy to miss.
 */
export function LifecyclePreview({
  action,
  from,
  to,
  title,
  affected,
  truncated,
}: {
  action: string;
  resourceType: "document" | "table";
  from: string | null;
  to: string | null;
  title: string | null;
  affected: { documents: number; tables: number };
  truncated: boolean;
}) {
  const carried = carriedLabel(affected);
  const isFolderDelete = action === "folder_delete";
  const isDelete = action === "item_delete" || isFolderDelete;
  const isCreate = action === "folder_create";

  return (
    <div className="border-line bg-surface rounded-md border px-2 py-1.5 text-[12px]">
      {title ? <p className="m-0 font-medium">{title}</p> : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {isCreate ? null : (
          <>
            <dt className="text-text-muted">From</dt>
            <dd className="m-0 font-mono break-all">{pathLabel(from)}</dd>
          </>
        )}
        {isDelete ? null : (
          <>
            <dt className="text-text-muted">To</dt>
            <dd className="m-0 font-mono break-all">{pathLabel(to)}</dd>
          </>
        )}
      </dl>
      {carried ? (
        <p className="text-text-muted m-0 pt-1">
          {/* A folder delete removes nothing beneath it; the count says what
              is still in the way. */}
          {isFolderDelete ? "Still holds" : isDelete ? "Removes" : "Moves"}{" "}
          {carried}
        </p>
      ) : null}
      {isFolderDelete ? (
        <p className="text-text-muted m-0 pt-1">
          Folder deletion is never recursive; only an empty folder can be
          removed.
          {carried
            ? " This folder is not empty, so the change will be refused."
            : ""}
        </p>
      ) : null}
      {truncated ? (
        <p className="text-text-muted m-0 pt-1">Preview shortened</p>
      ) : null}
    </div>
  );
}
