import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { withMermaidRendererMapping } from "~/app/(workspace)/projects/[projectId]/documents/_components/MermaidRenderer";
import { serializeDocumentBody } from "@weaver/core/editor/markdown";
import { chunkMarkdown } from "@weaver/core/knowledge/chunking";
import { renderDocumentContent } from "./render";

const existingTargetId = "11111111-1111-1111-1111-111111111111";
const missingTargetId = "22222222-2222-2222-2222-222222222222";

describe("renderDocumentContent", () => {
  it("prefixes document link marks for a deployed base path", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Runbook",
              marks: [
                { type: "link", attrs: { href: "/projects/p/documents/d" } },
              ],
            },
          ],
        },
      ],
    };
    expect(
      renderToStaticMarkup(
        renderDocumentContent(content, undefined, "/weaver"),
      ),
    ).toContain('href="/weaver/projects/p/documents/d"');
  });

  it.each(["blockquote", "callout", "bulletList"])(
    "preserves top-level anchors after headings in %s",
    (type) => {
      const heading = {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Nested" }],
      };
      const nested =
        type === "bulletList"
          ? {
              type,
              content: [
                { type: "listItem", content: [{ type: "paragraph" }, heading] },
              ],
            }
          : { type, content: [heading] };
      const html = renderToStaticMarkup(
        renderDocumentContent({
          type: "doc",
          content: [
            nested,
            { ...heading, content: [{ type: "text", text: "Top" }] },
          ],
        }),
      );
      expect(html).toContain(
        'id="section-top" data-document-section="true" tabindex="-1">Top',
      );
      expect(html).toContain(">Nested</h2>");
    },
  );
  it("renders TipTap JSON without an editor instance", () => {
    const html = renderToStaticMarkup(
      renderDocumentContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        ],
      }),
    );

    expect(html).toContain("<p>Hello</p>");
    expect(html).not.toContain("contenteditable");
  });

  it("opens external links in a safe new tab", () => {
    const html = renderToStaticMarkup(
      renderDocumentContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Example",
                marks: [
                  { type: "link", attrs: { href: "https://example.com" } },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders existing and broken references through a custom node mapping", () => {
    const resolved = new Map([
      [existingTargetId, { title: "Live title", href: "/documents/existing" }],
    ]);
    const html = renderToStaticMarkup(
      renderDocumentContent(
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "crossref",
                  attrs: {
                    targetId: existingTargetId,
                    label: "Stored title",
                  },
                },
                { type: "text", text: " and " },
                {
                  type: "crossref",
                  attrs: {
                    targetId: missingTargetId,
                    label: "Missing title",
                  },
                },
              ],
            },
          ],
        },
        {
          crossref: ({ node }) => {
            const targetId = String(node.attrs.targetId);
            const target = resolved.get(targetId);
            return target ? (
              <a href={target.href}>{target.title}</a>
            ) : (
              <span aria-label="Broken document reference">
                {String(node.attrs.label)}
              </span>
            );
          },
        },
      ),
    );

    expect(html).toContain('<a href="/documents/existing">Live title</a>');
    expect(html).toContain(
      '<span aria-label="Broken document reference">Missing title</span>',
    );
    expect(html).not.toContain("Stored title");
  });

  it("renders Mermaid without replacing an existing node mapping", () => {
    const html = renderToStaticMarkup(
      renderDocumentContent(
        {
          type: "doc",
          content: [
            { type: "mermaid", attrs: { source: "graph TD; A-->B;" } },
            {
              type: "paragraph",
              content: [
                {
                  type: "crossref",
                  attrs: {
                    targetId: existingTargetId,
                    label: "Stored title",
                  },
                },
              ],
            },
          ],
        },
        withMermaidRendererMapping({
          crossref: ({ node }) => (
            <span data-rendered-crossref>{String(node.attrs.label)}</span>
          ),
        }),
      ),
    );

    expect(html).toContain(
      'role="status" aria-label="Rendering Mermaid diagram"',
    );
    expect(html).toContain(
      '<span data-rendered-crossref="true">Stored title</span>',
    );
    expect(html).not.toContain("data-mermaid");
  });

  it("renders the same nested and duplicate section anchors as Markdown indexing", () => {
    const markup = renderToStaticMarkup(
      renderDocumentContent({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Deploy" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "First" }] },
          {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: "Verify" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "Second" }] },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Deploy" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "Third" }] },
          {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: "Verify" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "Fourth" }] },
        ],
      }),
    );
    const renderedAnchors = Array.from(
      markup.matchAll(/<h[1-6][^>]* id="([^"]+)"/g),
      (match) => match[1],
    );
    const indexedAnchors = chunkMarkdown({
      documentId: "document-1",
      sourceCommitSha: "a".repeat(40),
      title: "Runbook",
      markdown: [
        "## Deploy",
        "First",
        "### Verify",
        "Second",
        "## Deploy",
        "Third",
        "### Verify",
        "Fourth",
      ].join("\n"),
      maxChars: 1_000,
      overlapChars: 0,
    }).map((chunk) => chunk.navigationAnchor);

    expect(markup).toContain('id="section-deploy"');
    expect(markup).toContain('id="section-deploy-2"');
    expect(markup).toContain('data-document-section="true"');
    expect(markup).toContain('tabindex="-1"');
    expect(renderedAnchors).toEqual(indexedAnchors);
  });

  it("keeps heading anchors stable across React render retries", () => {
    const rendered = renderDocumentContent({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 } },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Deployment" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Deploy approved builds." }],
        },
      ],
    });

    const firstRender = renderToStaticMarkup(rendered);
    expect(renderToStaticMarkup(rendered)).toBe(firstRender);
  });

  it("matches canonical anchors for linked, marked, cross-reference, and empty headings", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            {
              type: "text",
              text: "Deploy",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Linked" }] },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            {
              type: "text",
              text: "Deploy",
              marks: [{ type: "bold" }, { type: "italic" }],
            },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Marked" }] },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            {
              type: "crossref",
              attrs: {
                targetType: "document",
                targetId: "11111111-1111-1111-1111-111111111111",
                label: "Runbook",
              },
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Cross-reference" }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Empty" }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Empty" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "After empty section" }],
        },
      ],
    };
    const markdown = serializeDocumentBody(content);
    const markup = renderToStaticMarkup(
      renderDocumentContent(content, {
        crossref: ({ node }) => <span>{String(node.attrs.label)}</span>,
      }),
    );
    const renderedAnchors = Array.from(
      markup.matchAll(/<h[1-6][^>]* id="([^"]+)"/g),
      (match) => match[1],
    );
    const indexedAnchors = chunkMarkdown({
      documentId: "document-1",
      sourceCommitSha: "a".repeat(40),
      title: "Runbook",
      markdown,
      maxChars: 1_000,
      overlapChars: 0,
    }).map((chunk) => chunk.navigationAnchor);

    expect(renderedAnchors).toEqual([
      "section-deploy-https-example-com",
      "section-deploy",
      "section-runbook-weaver-document-11111111-1111-1111-1111",
      "section-empty",
      "section-empty-2",
    ]);
    expect(indexedAnchors).toEqual([
      "section-deploy-https-example-com",
      "section-deploy",
      "section-runbook-weaver-document-11111111-1111-1111-1111",
      "section-empty",
      "section-empty-2",
    ]);
  });

  it("renders an omitted empty heading without shifting the next canonical anchor", () => {
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 } },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Deploy" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "!!!" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Punctuation" }],
        },
      ],
    };
    const markdown = serializeDocumentBody(content);
    const markup = renderToStaticMarkup(renderDocumentContent(content));
    const renderedAnchors = Array.from(
      markup.matchAll(/<h[1-6][^>]* id="([^"]+)"/g),
      (match) => match[1],
    );
    const indexedAnchors = chunkMarkdown({
      documentId: "document-1",
      sourceCommitSha: "a".repeat(40),
      title: "Runbook",
      markdown,
      maxChars: 1_000,
      overlapChars: 0,
    }).map((chunk) => chunk.navigationAnchor);

    expect(renderedAnchors).toHaveLength(3);
    expect(new Set(renderedAnchors)).toHaveProperty("size", 3);
    expect(renderedAnchors[1]).toBe("section-deploy");
    expect(renderedAnchors[2]).toBe("section");
    expect(indexedAnchors).toEqual(["section-deploy", "section"]);
  });

  it("renders images through a mapping that resolves relative sources", async () => {
    const { createDocumentImageMapping } =
      await import("~/app/(workspace)/projects/[projectId]/documents/_components/DocumentImageMapping");
    const projectId = "11111111-1111-4111-8111-111111111111";
    const html = renderToStaticMarkup(
      renderDocumentContent(
        {
          type: "doc",
          content: [
            {
              type: "image",
              attrs: { src: "guide.assets/a.png", alt: "Shot", title: "T" },
            },
            {
              type: "image",
              attrs: {
                src: "data:image/png;base64,AA",
                alt: "Bad",
                title: null,
              },
            },
          ],
        },
        createDocumentImageMapping(projectId, "docs/guide.md"),
      ),
    );
    expect(html).toContain(
      `src="/api/projects/${projectId}/files/docs/guide.assets/a.png"`,
    );
    expect(html).toContain('alt="Shot"');
    expect(html).toContain('title="T"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain("data:image/png");
    expect(html).toContain("Bad");
  });

  it("renders a stored image width and ignores an invalid one", async () => {
    const { createDocumentImageMapping } =
      await import("~/app/(workspace)/projects/[projectId]/documents/_components/DocumentImageMapping");
    const image = (src: string, width: unknown) => ({
      type: "image",
      attrs: { src, alt: "", title: null, width },
    });
    const html = renderToStaticMarkup(
      renderDocumentContent(
        {
          type: "doc",
          content: [image("a.png", 320), image("b.png", "9000")],
        },
        createDocumentImageMapping(
          "11111111-1111-4111-8111-111111111111",
          "guide.md",
        ),
      ),
    );
    expect(html).toMatch(/<img[^>]*a\.png"[^>]*width="320"/);
    expect(html).not.toMatch(/<img[^>]*b\.png"[^>]*width=/);
  });
});
