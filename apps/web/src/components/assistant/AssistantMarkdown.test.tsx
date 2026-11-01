import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import { renderDocumentContent } from "~/lib/editor/render";
import { withAssistantBasePath } from "./AssistantMarkdown";

const html = (markdown: string, basePath: string) =>
  renderToStaticMarkup(
    renderDocumentContent(
      withAssistantBasePath(parseDocumentBody(markdown), basePath),
    ),
  );

const fileLink = "[Plan](/projects/p1/artifacts?file=Plan.docx)";

describe("withAssistantBasePath", () => {
  it("prefixes an app-relative link under a deployment base path", () => {
    expect(html(fileLink, "/weaver")).toContain(
      'href="/weaver/projects/p1/artifacts?file=Plan.docx"',
    );
  });

  it("leaves an app-relative link alone without a base path", () => {
    expect(html(fileLink, "")).toContain(
      'href="/projects/p1/artifacts?file=Plan.docx"',
    );
  });

  it("does not prefix a link that already carries the base path", () => {
    expect(
      html("[Plan](/weaver/projects/p1/artifacts?file=Plan.docx)", "/weaver"),
    ).toContain('href="/weaver/projects/p1/artifacts?file=Plan.docx"');
  });

  it("leaves absolute and protocol-relative links untouched", () => {
    const markup = html(
      "[Site](https://example.test/a) [Net](//example.test/b)",
      "/weaver",
    );
    expect(markup).toContain('href="https://example.test/a"');
    expect(markup).toContain('href="//example.test/b"');
    expect(markup).not.toContain("/weaver/https");
  });

  // The Link extension drops a weaver:// href before it is rendered, so this
  // asserts the transform itself rather than the markup.
  it("leaves a weaver:// link untouched", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Doc",
              marks: [
                {
                  type: "link",
                  attrs: { href: "weaver://projects/p1/documents/d1" },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(withAssistantBasePath(doc, "/weaver")).toEqual(doc);
  });

  it("keeps the renderer's own safe-tab attributes on a prefixed link", () => {
    const markup = html(fileLink, "/weaver");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it("prefixes a link nested inside a list item", () => {
    expect(html(`- ${fileLink}`, "/weaver")).toContain(
      'href="/weaver/projects/p1/artifacts?file=Plan.docx"',
    );
  });
});
