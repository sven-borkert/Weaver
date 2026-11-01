import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { renderDocumentContent } from "./render";
import {
  createDocumentSectionAnchorPlugin,
  documentOutlineFromState,
} from "./document-section-anchors";

const schema = getSchema(documentExtensions());
const anchorOf = (decoration: Decoration) =>
  (decoration as unknown as { type: { attrs: { id: string } } }).type.attrs.id;
const heading = (text: string, level = 2) => ({
  type: "heading",
  attrs: { level },
  ...(text ? { content: [{ type: "text", text }] } : {}),
});

describe("editable document section anchors", () => {
  it("keeps temporary highlights in decorations across editor transactions without saving them", () => {
    const plugin = createDocumentSectionAnchorPlugin();
    let state = EditorState.create({
      doc: schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Body" }] },
          heading("Deploy"),
        ],
      }),
      plugins: [plugin],
    });
    const original = state.doc;
    const start = state.tr.setMeta(
      "documentSectionHighlight",
      "section-deploy",
    );
    expect(start.docChanged).toBe(false);
    state = state.apply(start);
    const highlighted = () =>
      (
        plugin.getState(state)!.decorations.find()[0] as unknown as {
          type: { attrs: Record<string, string> };
        }
      ).type.attrs["data-section-highlight"];
    expect(highlighted()).toBe("true");
    expect(state.doc).toBe(original);
    state = state.apply(state.tr.setMeta("focus", true));
    expect(highlighted()).toBe("true");
    state = state.apply(state.tr.insertText("Extra ", 1));
    expect(highlighted()).toBe("true");
    const stop = state.tr.setMeta("documentSectionHighlight", null);
    expect(stop.docChanged).toBe(false);
    state = state.apply(stop);
    expect(highlighted()).toBeUndefined();
    expect(JSON.stringify(state.doc.toJSON())).not.toContain("highlight");
  });

  it("matches static reader anchors without changing saved heading attributes", () => {
    const content = {
      type: "doc",
      content: [
        { type: "blockquote", content: [heading("Nested")] },
        heading(""),
        heading("Deploy"),
        heading("Verify", 3),
        heading("Deploy"),
        heading("!!!"),
      ],
    };
    const doc = schema.nodeFromJSON(content);
    const plugin = createDocumentSectionAnchorPlugin();
    const state = EditorState.create({ doc, plugins: [plugin] });
    const anchors = plugin
      .getState(state)!
      .decorations.find()
      .sort((a, b) => a.from - b.from);
    expect(anchors.map(anchorOf)).toEqual([
      "section-2",
      "section-3",
      "section-deploy",
      "section-deploy--verify",
      "section-deploy-2",
      "section",
    ]);
    const staticIds = Array.from(
      renderToStaticMarkup(renderDocumentContent(content)).matchAll(
        /<h[1-6][^>]* id="([^"]+)"/g,
      ),
      (match) => match[1],
    );
    expect(anchors.map(anchorOf)).toEqual(staticIds);
    expect(state.doc.toJSON()).toEqual(doc.toJSON());
    expect(JSON.stringify(state.doc.toJSON())).not.toContain("section-");
  });

  it("reallocates a heading when formatting nests it without changing its text", () => {
    const plugin = createDocumentSectionAnchorPlugin();
    let state = EditorState.create({
      doc: schema.nodeFromJSON({
        type: "doc",
        content: [heading("Deploy"), heading("Next")],
      }),
      plugins: [plugin],
    });
    const range = state.doc.resolve(1).blockRange(state.doc.resolve(2))!;
    state = state.apply(
      state.tr.wrap(range, [{ type: schema.nodes.blockquote! }]),
    );
    const anchors = plugin
      .getState(state)!
      .decorations.find()
      .sort((a, b) => a.from - b.from);
    expect(anchors.map(anchorOf)).toEqual(["section", "section-next"]);
  });

  it("maps unchanged headings across body edits and reallocates a changed heading", () => {
    const plugin = createDocumentSectionAnchorPlugin();
    let state = EditorState.create({
      doc: schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Body" }] },
          heading("Deploy"),
        ],
      }),
      plugins: [plugin],
    });
    const original = plugin.getState(state)!.decorations.find()[0]!;
    state = state.apply(state.tr.insertText("Extra ", 1));
    const moved = plugin.getState(state)!.decorations.find()[0]!;
    expect(moved.from).toBe(original.from + 6);
    expect(anchorOf(moved)).toBe("section-deploy");
    state = state.apply(state.tr.insertText("New ", moved.from + 1));
    expect(anchorOf(plugin.getState(state)!.decorations.find()[0]!)).toBe(
      "section-new-deploy",
    );
    const unchanged = state.doc;
    state = state.apply(state.tr.setMeta("presentation", true));
    expect(state.doc).toBe(unchanged);
    expect(state.tr.docChanged).toBe(false);
  });

  it("keeps the same outline until a heading's text, level, or anchor changes", () => {
    const plugin = createDocumentSectionAnchorPlugin();
    let state = EditorState.create({
      doc: schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Body" }] },
          heading("Deploy"),
          heading("Verify", 3),
        ],
      }),
      plugins: [plugin],
    });
    const outline = documentOutlineFromState(state);
    expect(outline).toEqual([
      { anchor: "section-deploy", level: 2, text: "Deploy" },
      { anchor: "section-deploy--verify", level: 3, text: "Verify" },
    ]);
    state = state.apply(state.tr.insertText("Extra ", 1));
    expect(documentOutlineFromState(state)).toBe(outline);
    state = state.apply(
      state.tr.setMeta("documentSectionHighlight", "section-deploy"),
    );
    expect(documentOutlineFromState(state)).toBe(outline);
    state = state.apply(state.tr.addMark(13, 19, schema.marks.bold!.create()));
    expect(documentOutlineFromState(state)).toBe(outline);
    state = state.apply(state.tr.insertText("New ", 13));
    expect(documentOutlineFromState(state)?.[0]).toEqual({
      anchor: "section-new-deploy",
      level: 2,
      text: "New Deploy",
    });
  });

  it("reports no outline for a state without the anchor plugin", () => {
    expect(
      documentOutlineFromState(
        EditorState.create({ doc: schema.nodeFromJSON({ type: "doc" }) }),
      ),
    ).toBeUndefined();
  });
});
