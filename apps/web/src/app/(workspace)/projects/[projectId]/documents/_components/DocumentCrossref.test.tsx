import { getSchema, type JSONContent } from "@tiptap/core";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { serializeDocumentBody } from "@weaver/core/editor/markdown";
import {
  DocumentCrossref,
  DocumentCrossrefNodeView,
  DocumentReferenceProvider,
} from "./DocumentCrossref";

const id = "11111111-1111-4111-8111-111111111111";
const content = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "crossref",
          attrs: { targetType: "table", targetId: id, label: "Stored name" },
        },
      ],
    },
  ],
};

it("renders live typed reference previews inside the editable document", () => {
  const node =
    getSchema(documentExtensions()).nodeFromJSON(content).firstChild!
      .firstChild!;
  const html = renderToStaticMarkup(
    <DocumentReferenceProvider
      projectId="project"
      status="settled"
      targets={[
        {
          id,
          exists: true,
          targetType: "table",
          title: "Current table",
          path: "tables/current",
          excerpt: "",
          lastEditedAt: new Date("2026-09-14T00:00:00Z"),
        },
      ]}
    >
      <DocumentCrossrefNodeView node={node} />
    </DocumentReferenceProvider>,
  );
  expect(html).toContain('href="/projects/project/tables/' + id + '"');
  expect(html).toContain("Current table");
  expect(html).not.toContain("Stored name");
  expect(html).toContain('contentEditable="false"');
});

it("keeps unresolved references neutral while loading and metadata-free after failure", () => {
  const node =
    getSchema(documentExtensions()).nodeFromJSON(content).firstChild!
      .firstChild!;
  for (const status of ["pending", "error"] as const) {
    const html = renderToStaticMarkup(
      <DocumentReferenceProvider
        projectId="project"
        status={status}
        targets={[]}
      >
        <DocumentCrossrefNodeView node={node} />
      </DocumentReferenceProvider>,
    );
    expect(html).toContain(
      status === "pending"
        ? "Loading table reference"
        : "Broken table reference",
    );
    expect(html).toContain("Stored name");
    expect(html).not.toContain(id);
    expect(html).not.toContain("href=");
  }
});

it("preserves the canonical cross-reference document schema and Markdown", () => {
  const schema = getSchema(documentExtensions({ crossref: DocumentCrossref }));
  expect(
    serializeDocumentBody(schema.nodeFromJSON(content).toJSON() as JSONContent),
  ).toBe(`[Stored name](weaver://table/${id})\n`);
});
