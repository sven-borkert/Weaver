import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableToolbar } from "./TableToolbar";

const noop = () => undefined;

describe("TableToolbar", () => {
  it("renders extraActions for a Viewer (canEdit false)", () => {
    const html = renderToStaticMarkup(
      <TableToolbar
        title="My table"
        dirty={false}
        canEdit={false}
        selectedRowCount={0}
        rowCount={0}
        columns={[]}
        busy={false}
        savePending={false}
        onTitleChange={noop}
        onAddRow={noop}
        onDeleteRows={noop}
        onAddColumnRequest={noop}
        onRenameColumnRequest={noop}
        onRetypeColumnRequest={noop}
        onOptionsColumnRequest={noop}
        onDeleteColumnRequest={noop}
        onMoveColumn={noop}
        onSaveRequest={noop}
        extraActions={<button type="button">Send to another Weaver…</button>}
        compactExtraActions={
          <button type="button">Send to another Weaver… (compact)</button>
        }
      />,
    );
    expect(html).toContain("Send to another Weaver…");
    expect(html).toContain("Send to another Weaver… (compact)");
  });
});
