import type { TableDiff } from "@weaver/core/tables/diff";
import type { TableColumn } from "@weaver/core/tables/types";
import { capDiffSections } from "~/lib/assistant/proposalPreview";
import { presentTableDiff } from "~/lib/tables/presentation";

const MAX_ITEMS_PER_SECTION = 50;

/**
 * Reuses `presentTableDiff` so a proposed table change reads in exactly the
 * same words as the version-comparison view (TableDiff.tsx).
 */
export function TableDiffPreview({
  diff,
  columns,
  truncated,
}: {
  diff: TableDiff;
  columns: readonly TableColumn[];
  truncated: boolean;
}) {
  const sections = capDiffSections(
    presentTableDiff(diff, columns),
    MAX_ITEMS_PER_SECTION,
  );

  return (
    <div className="border-line bg-surface overflow-hidden rounded-md border">
      {sections.length === 0 ? (
        <p className="text-text-muted m-0 px-2 py-1.5 text-[12px]">
          No table changes
        </p>
      ) : (
        <div className="scrollarea divide-line-faint max-h-80 divide-y overflow-auto">
          {sections.map((section) => (
            <section key={section.kind}>
              <h4 className="text-text-2 bg-surface-2 m-0 px-2 py-1 text-[11px] font-semibold">
                {section.heading}
              </h4>
              <ul className="m-0 flex list-none flex-col p-0">
                {section.items.map((item, index) => (
                  <li
                    key={`${section.kind}:${index}`}
                    className="text-text-2 px-2 py-0.5 text-[12px] break-words"
                  >
                    {item}
                  </li>
                ))}
                {section.hidden > 0 ? (
                  <li className="text-text-muted px-2 py-0.5 text-[12px]">
                    …and {section.hidden.toLocaleString("en-US")} more
                  </li>
                ) : null}
              </ul>
            </section>
          ))}
        </div>
      )}
      {truncated ? (
        <p className="text-text-muted border-line m-0 border-t px-2 py-1 text-[11px]">
          Preview shortened to fit
        </p>
      ) : null}
    </div>
  );
}
