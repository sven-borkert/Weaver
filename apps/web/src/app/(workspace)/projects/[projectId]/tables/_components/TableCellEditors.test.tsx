import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TableColumn } from "@weaver/core/tables/types";
import {
  BooleanCellValue,
  DateTimeCellRenderer,
  LongTextCellRenderer,
  MultiselectCellRenderer,
  orderSelectedOptionIds,
  UrlCellRenderer,
} from "./TableCellEditors";

const TAGS_COLUMN: TableColumn = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tags",
  type: "multiselect",
  options: [
    { id: "22222222-2222-4222-8222-222222222222", label: "Alpha" },
    { id: "33333333-3333-4333-8333-333333333333", label: "Beta" },
  ],
};

describe("BooleanCellValue", () => {
  it("renders empty, false, and true as distinct safe selectable states", () => {
    const empty = renderToStaticMarkup(
      <BooleanCellValue value={undefined} columnName="Complete" />,
    );
    const falseValue = renderToStaticMarkup(
      <BooleanCellValue value={false} columnName="Complete" />,
    );
    const trueValue = renderToStaticMarkup(
      <BooleanCellValue value={true} columnName="Complete" />,
    );

    expect(empty).toContain("Complete: empty");
    expect(empty).toContain(">—<");
    expect(empty).not.toContain('type="checkbox"');

    expect(falseValue).toContain('type="checkbox"');
    expect(falseValue).toContain('aria-label="Complete: false"');
    expect(falseValue).not.toContain('checked=""');
    expect(falseValue).toContain("select-text");
    expect(falseValue).toContain(">False<");

    expect(trueValue).toContain('type="checkbox"');
    expect(trueValue).toContain('aria-label="Complete: true"');
    expect(trueValue).toContain('checked=""');
    expect(trueValue).toContain("select-text");
    expect(trueValue).toContain(">True<");
  });
});

describe("UrlCellRenderer", () => {
  it("renders an anchor that opens the link safely in a new tab", () => {
    const html = renderToStaticMarkup(
      <UrlCellRenderer
        {...({
          value: "https://example.test/path",
        } as unknown as ComponentProps<typeof UrlCellRenderer>)}
      />,
    );

    expect(html).toContain('href="https://example.test/path"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("example.test/path");
  });

  it("renders an empty dash for a missing value", () => {
    const html = renderToStaticMarkup(
      <UrlCellRenderer
        {...({ value: undefined } as unknown as ComponentProps<
          typeof UrlCellRenderer
        >)}
      />,
    );
    expect(html).toContain(">—<");
    expect(html).not.toContain("<a ");
  });

  it("renders plain text instead of a link for an invalid url cell", () => {
    const html = renderToStaticMarkup(
      <UrlCellRenderer
        {...({ value: "not a url" } as unknown as ComponentProps<
          typeof UrlCellRenderer
        >)}
      />,
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("not a url");
  });
});

describe("MultiselectCellRenderer", () => {
  it("renders one chip per selected label", () => {
    const html = renderToStaticMarkup(
      <MultiselectCellRenderer
        {...({
          value: [TAGS_COLUMN.options![0]!.id, TAGS_COLUMN.options![1]!.id],
          column: TAGS_COLUMN,
        } as unknown as ComponentProps<typeof MultiselectCellRenderer>)}
      />,
    );

    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html.match(/border-line/g)?.length).toBe(2);
  });

  it("renders an empty dash for no selection", () => {
    const html = renderToStaticMarkup(
      <MultiselectCellRenderer
        {...({
          value: undefined,
          column: TAGS_COLUMN,
        } as unknown as ComponentProps<typeof MultiselectCellRenderer>)}
      />,
    );
    expect(html).toContain(">—<");
  });
});

describe("DateTimeCellRenderer", () => {
  it("renders the formatted value with the raw cell as the title", () => {
    const html = renderToStaticMarkup(
      <DateTimeCellRenderer
        {...({ value: "2026-09-18T12:30:00Z" } as unknown as ComponentProps<
          typeof DateTimeCellRenderer
        >)}
      />,
    );
    expect(html).toContain('title="2026-09-18T12:30:00Z"');
  });

  it("renders an empty dash for a missing value", () => {
    const html = renderToStaticMarkup(
      <DateTimeCellRenderer
        {...({ value: undefined } as unknown as ComponentProps<
          typeof DateTimeCellRenderer
        >)}
      />,
    );
    expect(html).toContain(">—<");
  });
});

describe("LongTextCellRenderer", () => {
  it("shows only the first line, not the rest of the text", () => {
    const html = renderToStaticMarkup(
      <LongTextCellRenderer
        {...({
          value: "First line\nSecond line\nThird line",
          columnName: "Notes",
          onExpand: () => undefined,
        } as unknown as ComponentProps<typeof LongTextCellRenderer>)}
      />,
    );

    expect(html).toContain("First line");
    expect(html).not.toContain("Second line");
    expect(html).not.toContain("Third line");
    expect(html).toContain('aria-label="Expand Notes"');
    // The expand dialog now lives at grid level (TableGrid.tsx), so this
    // renderer's own markup never includes dialog content.
    expect(html).not.toContain("Raw text");
  });

  it("renders an empty dash for a missing value", () => {
    const html = renderToStaticMarkup(
      <LongTextCellRenderer
        {...({
          value: undefined,
          columnName: "Notes",
          onExpand: () => undefined,
        } as unknown as ComponentProps<typeof LongTextCellRenderer>)}
      />,
    );
    expect(html).toContain(">—<");
  });
});

describe("orderSelectedOptionIds", () => {
  const options = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("orders selected ids by column.options order, not toggle order", () => {
    expect(orderSelectedOptionIds(options, ["c", "a"])).toEqual(["a", "c"]);
    expect(orderSelectedOptionIds(options, ["b", "a", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops ids that are not in options and dedupes", () => {
    expect(orderSelectedOptionIds(options, ["z", "a", "a"])).toEqual(["a"]);
  });

  it("returns an empty array for no selection", () => {
    expect(orderSelectedOptionIds(options, [])).toEqual([]);
  });
});
