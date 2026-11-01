import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentDiffPreview } from "./DocumentDiffPreview";
import { LifecyclePreview } from "./LifecyclePreview";
import { TableCreatePreview } from "./TableCreatePreview";
import { TableDiffPreview } from "./TableDiffPreview";

const lines = Array.from({ length: 60 }, (_, i) => ({
  type:
    i % 3 === 0
      ? ("add" as const)
      : i % 3 === 1
        ? ("del" as const)
        : ("same" as const),
  text: `line ${i}`,
}));

describe("DocumentDiffPreview", () => {
  it("collapses beyond 40 lines and offers the full count", () => {
    const html = renderToStaticMarkup(
      <DocumentDiffPreview lines={lines} truncated={false} />,
    );
    expect(html).toContain("line 39");
    expect(html).not.toContain("line 40");
    expect(html).toContain("Show all 60 lines");
  });

  it("does not offer expansion when everything already fits", () => {
    const html = renderToStaticMarkup(
      <DocumentDiffPreview lines={lines.slice(0, 3)} truncated={false} />,
    );
    expect(html).toContain("line 2");
    expect(html).not.toContain("Show all");
  });

  it("names the line limit only when the diff actually reached it", () => {
    const atLimit = Array.from({ length: 2_000 }, (_, i) => ({
      type: "add" as const,
      text: `line ${i}`,
    }));
    expect(
      renderToStaticMarkup(<DocumentDiffPreview lines={atLimit} truncated />),
    ).toContain("Preview limited to 2,000 lines");
  });

  it("stays generic when boundedJson's byte budget cut the array short", () => {
    // `linePreview` slices to exactly 2,000 lines when the line limit fires,
    // so a truncated preview holding three lines was shrunk for size — the
    // 2,000-line copy would be a false statement about what is on screen.
    const html = renderToStaticMarkup(
      <DocumentDiffPreview lines={lines.slice(0, 3)} truncated />,
    );
    expect(html).toContain("Preview shortened");
    expect(html).not.toContain("2,000 lines");
  });

  it("tints added and removed lines with the lifecycle tokens", () => {
    const html = renderToStaticMarkup(
      <DocumentDiffPreview lines={lines.slice(0, 3)} truncated={false} />,
    );
    expect(html).toMatch(/data-line-type="add" class="[^"]*bg-approved-bg/);
    expect(html).toMatch(/data-line-type="del" class="[^"]*bg-danger-bg/);
    const same = /data-line-type="same" class="([^"]*)"/.exec(html);
    expect(same?.[1]).not.toMatch(/bg-(approved|danger)-bg/);
  });

  it("renders an empty diff as a stated no-op rather than a blank box", () => {
    expect(
      renderToStaticMarkup(
        <DocumentDiffPreview lines={[]} truncated={false} />,
      ),
    ).toContain("No text changes");
  });
});

describe("TableDiffPreview", () => {
  it("uses the app's own diff vocabulary and caps long sections", () => {
    const html = renderToStaticMarkup(
      <TableDiffPreview
        truncated={false}
        columns={[
          { id: "c1", name: "Owner", type: "text" },
          { id: "c2", name: "Budget", type: "number" },
        ]}
        diff={{
          titleChange: null,
          columnChanges: [
            {
              kind: "added",
              column: { id: "c1", name: "Owner", type: "text" },
            },
            { kind: "renamed", columnId: "c2", from: "Cost", to: "Budget" },
            {
              kind: "removed",
              column: { id: "c3", name: "Legacy", type: "number" },
            },
          ],
          columnsReordered: false,
          rowsReordered: false,
          addedRows: ["r1", "r2"],
          removedRows: [],
          changedCells: Array.from({ length: 55 }, (_, i) => ({
            rowId: `row${i}`,
            columnId: "c1",
            from: null,
            to: "b",
          })),
        }}
      />,
    );
    expect(html).toContain("Added Owner (text)");
    expect(html).toContain("Renamed Cost → Budget");
    expect(html).toContain("Removed Legacy (number)");
    expect(html).toContain("Row row1 ");
    expect(html).toContain("Empty → b");
    expect(html).toContain("…and 5 more");
    // The 51st cell change and beyond are hidden behind the count.
    expect(html).not.toContain("row50");
  });

  it("states an empty diff instead of rendering nothing", () => {
    expect(
      renderToStaticMarkup(
        <TableDiffPreview
          truncated={false}
          columns={[]}
          diff={{
            titleChange: null,
            columnChanges: [],
            columnsReordered: false,
            rowsReordered: false,
            addedRows: [],
            removedRows: [],
            changedCells: [],
          }}
        />,
      ),
    ).toContain("No table changes");
  });

  it("says when the stored preview itself was shortened", () => {
    expect(
      renderToStaticMarkup(
        <TableDiffPreview
          truncated
          columns={[]}
          diff={{
            titleChange: null,
            columnChanges: [],
            columnsReordered: false,
            rowsReordered: false,
            addedRows: [],
            removedRows: [],
            changedCells: [],
          }}
        />,
      ),
    ).toContain("Preview shortened to fit");
  });
});

describe("TableCreatePreview", () => {
  it("renders the sampled rows and says how many the sample leaves out", () => {
    const html = renderToStaticMarkup(
      <TableCreatePreview
        truncated={false}
        columns={[
          { id: "c1", name: "Name", type: "text" },
          { id: "c2", name: "Done", type: "boolean" },
        ]}
        rowCount={42}
        sampleRows={[
          { id: "r1", cells: { c1: "Ada", c2: true } },
          { id: "r2", cells: { c1: "Grace" } },
        ]}
      />,
    );
    expect(html).toContain("Name");
    expect(html).toContain("(text)");
    expect(html).toContain("Ada");
    expect(html).toContain("Yes");
    expect(html).toContain("Grace");
    expect(html).toContain("Showing 2 of 42 rows");
  });

  it("says nothing about sampling when every row is shown", () => {
    const html = renderToStaticMarkup(
      <TableCreatePreview
        truncated={false}
        columns={[{ id: "c1", name: "Name", type: "text" }]}
        rowCount={1}
        sampleRows={[{ id: "r1", cells: { c1: "Ada" } }]}
      />,
    );
    expect(html).not.toContain("Showing");
    expect(html).toContain("1 row");
  });
});

describe("LifecyclePreview", () => {
  it("distinguishes an empty-string root destination from a null one", () => {
    // `to: ""` (the scope root) and `to: null` (no destination, i.e. a
    // delete) must render differently — this is the pair Task 7's preview
    // shape is easiest to get backwards.
    const root = renderToStaticMarkup(
      <LifecyclePreview
        action="item_move"
        resourceType="document"
        from="archive"
        to=""
        title={null}
        affected={{ documents: 0, tables: 0 }}
        truncated={false}
      />,
    );
    expect(root).toContain("project root");

    const none = renderToStaticMarkup(
      <LifecyclePreview
        action="item_move"
        resourceType="document"
        from="archive"
        to={null}
        title={null}
        affected={{ documents: 0, tables: 0 }}
        truncated={false}
      />,
    );
    expect(none).not.toContain("project root");
  });

  it("omits the From row for a folder create, and the To row for a delete", () => {
    const create = renderToStaticMarkup(
      <LifecyclePreview
        action="folder_create"
        resourceType="document"
        from={null}
        to="archive/2026"
        title={null}
        affected={{ documents: 0, tables: 0 }}
        truncated={false}
      />,
    );
    expect(create).not.toContain(">From<");
    expect(create).toContain(">To<");
    expect(create).toContain("archive/2026");

    const del = renderToStaticMarkup(
      <LifecyclePreview
        action="item_delete"
        resourceType="table"
        from="tables/roster.table"
        to={null}
        title="Roster"
        affected={{ documents: 0, tables: 1 }}
        truncated={false}
      />,
    );
    expect(del).toContain(">From<");
    expect(del).toContain("tables/roster.table");
    expect(del).not.toContain(">To<");
  });

  it("pluralizes the carried count independently and joins documents with tables", () => {
    const singular = renderToStaticMarkup(
      <LifecyclePreview
        action="folder_move"
        resourceType="document"
        from="archive"
        to="store/archive"
        title={null}
        affected={{ documents: 1, tables: 0 }}
        truncated={false}
      />,
    );
    expect(singular).toContain("Moves 1 document");
    expect(singular).not.toContain("1 documents");

    const joined = renderToStaticMarkup(
      <LifecyclePreview
        action="folder_move"
        resourceType="document"
        from="archive"
        to="store/archive"
        title={null}
        affected={{ documents: 3, tables: 1 }}
        truncated={false}
      />,
    );
    expect(joined).toContain("Moves 3 documents and 1 table");
  });

  it("says nothing carried when nothing moves or is removed", () => {
    const html = renderToStaticMarkup(
      <LifecyclePreview
        action="folder_rename"
        resourceType="document"
        from="archive"
        to="archives"
        title={null}
        affected={{ documents: 0, tables: 0 }}
        truncated={false}
      />,
    );
    expect(html).not.toContain("Moves");
    expect(html).not.toContain("Removes");
  });

  it("says Removes rather than Moves for a delete", () => {
    const html = renderToStaticMarkup(
      <LifecyclePreview
        action="item_delete"
        resourceType="table"
        from="tables/roster.table"
        to={null}
        title="Roster"
        affected={{ documents: 0, tables: 3 }}
        truncated={false}
      />,
    );
    expect(html).toContain("Removes 3 tables");
    expect(html).not.toContain("Moves");
  });

  it("shows the folder-delete note only for that action", () => {
    const del = renderToStaticMarkup(
      <LifecyclePreview
        action="folder_delete"
        resourceType="document"
        from="archive"
        to={null}
        title={null}
        affected={{ documents: 0, tables: 0 }}
        truncated={false}
      />,
    );
    expect(del).toContain(
      "Folder deletion is never recursive; only an empty folder can be removed.",
    );
    expect(del).not.toContain("will be refused");

    const move = renderToStaticMarkup(
      <LifecyclePreview
        action="folder_move"
        resourceType="document"
        from="archive"
        to="store/archive"
        title={null}
        affected={{ documents: 0, tables: 0 }}
        truncated={false}
      />,
    );
    expect(move).not.toContain("Folder deletion is never recursive");
  });

  it("never claims a folder-delete removes what it counts, nor that it is empty", () => {
    // `prepare` counts everything under the folder for every non-create folder
    // action, folder_delete included, so a non-empty folder must not read as
    // "Removes 3 documents" above an assertion that the folder is empty.
    const html = renderToStaticMarkup(
      <LifecyclePreview
        action="folder_delete"
        resourceType="document"
        from="archive"
        to={null}
        title={null}
        affected={{ documents: 3, tables: 0 }}
        truncated={false}
      />,
    );
    expect(html).toContain("Still holds 3 documents");
    expect(html).not.toContain("Removes");
    expect(html).toContain(
      "This folder is not empty, so the change will be refused.",
    );
    expect(html).not.toContain("this folder is empty");
  });

  it("surfaces the truncation notice when the stored preview was shortened", () => {
    const html = renderToStaticMarkup(
      <LifecyclePreview
        action="folder_move"
        resourceType="document"
        from="archive"
        to="store/archive"
        title={null}
        affected={{ documents: 0, tables: 0 }}
        truncated
      />,
    );
    expect(html).toContain("Preview shortened");
  });
});
