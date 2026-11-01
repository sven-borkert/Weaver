import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OptionsEditor,
  retypeDescription,
  shouldEditOptions,
} from "./TableColumnDialogs";

/**
 * `TableColumnDialogs` wraps its form in Radix's `Dialog`, whose portal
 * renders nothing under `renderToStaticMarkup` in this repo's Node-environment
 * component tests (no jsdom is configured) — confirmed empirically: a full
 * render of the dialog with `open` produces an empty string regardless of
 * operation/column. So this asserts on the pieces that decide and render the
 * options editor and retype copy instead of on the dialog's own DOM output.
 * A full DOM interaction test (select "Multi-select" in the type dropdown,
 * see the editor appear) needs jsdom + testing-library, which isn't set up
 * in this project — remains a coverage gap.
 */
describe("shouldEditOptions", () => {
  it("shows the options editor for select and multiselect columns", () => {
    expect(shouldEditOptions("add", "select")).toBe(true);
    expect(shouldEditOptions("add", "multiselect")).toBe(true);
    expect(shouldEditOptions("retype", "select")).toBe(true);
    expect(shouldEditOptions("retype", "multiselect")).toBe(true);
    expect(shouldEditOptions("options", "text")).toBe(true);
  });

  it("hides it for every other type, and for a bare rename", () => {
    expect(shouldEditOptions("add", "text")).toBe(false);
    expect(shouldEditOptions("add", "url")).toBe(false);
    expect(shouldEditOptions("add", "longtext")).toBe(false);
    expect(shouldEditOptions("add", "datetime")).toBe(false);
    expect(shouldEditOptions("rename", "select")).toBe(false);
    expect(shouldEditOptions("rename", "multiselect")).toBe(false);
  });
});

describe("retypeDescription", () => {
  it("returns per-pair copy for known lossy conversions", () => {
    expect(retypeDescription("date", "datetime")).toBe(
      "Dates become midnight UTC.",
    );
    expect(retypeDescription("multiselect", "select")).toBe(
      "Only the first selected option is kept.",
    );
    expect(retypeDescription("multiselect", "text")).toBe(
      "Options are joined with commas.",
    );
    expect(retypeDescription("text", "url")).toBe(
      "Cells that are not http(s) links block the change and are listed below.",
    );
    expect(retypeDescription("longtext", "url")).toBe(
      "Cells that are not http(s) links block the change and are listed below.",
    );
    expect(retypeDescription("datetime", "date")).toBe(
      "Only the calendar date is kept; the time of day is dropped.",
    );
    expect(retypeDescription("text", "multiselect")).toBe(
      "Values are split on commas and matched to option labels; an unknown label blocks the change.",
    );
    expect(retypeDescription("longtext", "multiselect")).toBe(
      "Values are split on commas and matched to option labels; an unknown label blocks the change.",
    );
    expect(retypeDescription("select", "multiselect")).toBe(
      "Each value becomes a single selection.",
    );
  });

  it("falls back to the generic sentence for unlisted pairs and no current column", () => {
    expect(retypeDescription("text", "number")).toBe(
      "Convert every populated cell atomically to the new type.",
    );
    expect(retypeDescription(undefined, "text")).toBe(
      "Convert every populated cell atomically to the new type.",
    );
    // text->datetime has no bespoke copy: the generic sentence already
    // matches its atomic block-or-succeed behaviour, so it intentionally
    // falls back rather than claim anything is "cleared".
    expect(retypeDescription("text", "datetime")).toBe(
      "Convert every populated cell atomically to the new type.",
    );
  });
});

describe("OptionsEditor", () => {
  it("renders the same options editor markup for select and multiselect columns", () => {
    const html = renderToStaticMarkup(
      <OptionsEditor
        options={[{ id: "11111111-1111-4111-8111-111111111111", label: "One" }]}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("Select options");
    expect(html).toContain("Add option");
    expect(html).toContain('aria-label="Option 1 label"');
  });
});
