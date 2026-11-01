import { describe, expect, it } from "vitest";
import {
  crossrefTargetKey,
  parseDocumentBody,
} from "@weaver/core/editor/markdown";
import { buildDocumentPrintHtml, escapeHtml } from "./html";

const metadata = {
  createdAt: new Date("2026-01-02T10:00:00.000Z"),
  createdBy: { name: "Ada <Lovelace>" },
  updatedAt: new Date("2026-03-04T11:30:00.000Z"),
  updatedBy: { name: 'Bob "B" Builder' },
};

const id = "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c";

function html(
  markdown: string,
  extra: Partial<Parameters<typeof buildDocumentPrintHtml>[0]> = {},
) {
  return buildDocumentPrintHtml({
    title: "Plan & <Roadmap>",
    metadata,
    contentJson: parseDocumentBody(markdown),
    images: new Map(),
    crossrefTitles: new Map(),
    mermaidScript: "",
    ...extra,
  });
}

describe("buildDocumentPrintHtml", () => {
  it("escapes the title, author names and alt text", () => {
    const page = html('![a "quoted" <alt>](missing.png)\n');
    expect(page).toContain("<title>Plan &amp; &lt;Roadmap&gt;</title>");
    expect(page).toContain('<h1 class="title">Plan &amp; &lt;Roadmap&gt;</h1>');
    expect(page).toContain("Ada &lt;Lovelace&gt;");
    expect(page).toContain("Bob &quot;B&quot; Builder");
    expect(page).not.toContain("<alt>");
    expect(page).toContain("Image unavailable: missing.png");
  });

  it("inlines a known image as a data URI", () => {
    const page = html("![Diagram](plan.assets/diagram.png)\n", {
      images: new Map([
        [
          "plan.assets/diagram.png",
          {
            contentType: "image/png",
            bytes: new Uint8Array([137, 80, 78, 71]),
          },
        ],
      ]),
    });
    expect(page).toContain('src="data:image/png;base64,iVBORw=="');
    expect(page).toContain('alt="Diagram"');
  });

  it("prints an image at its stored width", () => {
    const image = {
      contentType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
    };
    const page = html(
      '<img src="a.png" alt="Wide &quot;A&quot;" width="320">\n\n![Plain](b.png)\n',
      {
        images: new Map([
          ["a.png", image],
          ["b.png", image],
        ]),
      },
    );
    expect(page).toContain(
      '<img src="data:image/png;base64,iVBORw==" alt="Wide &quot;A&quot;" width="320">',
    );
    expect(page).toContain(
      '<img src="data:image/png;base64,iVBORw==" alt="Plain">',
    );
  });

  it("prints the metadata line with UTC dates", () => {
    expect(html("Body.\n")).toContain(
      "Created 2026-01-02 10:00 UTC by Ada &lt;Lovelace&gt; · Updated 2026-03-04 11:30 UTC by Bob &quot;B&quot; Builder",
    );
  });

  it("renders a cross-reference as its current title", () => {
    const page = html(`See [Old label](weaver://document/${id}).\n`, {
      crossrefTitles: new Map([
        [crossrefTargetKey("document", id), "New title"],
      ]),
    });
    expect(page).toContain('<span class="crossref">New title</span>');
  });

  it("prints a deleted cross-reference's label", () => {
    expect(html(`See [Old label](weaver://document/${id}).\n`)).toContain(
      '<span class="crossref">Old label</span>',
    );
  });

  it("wraps Mermaid blocks for the inlined bundle and marks the page ready without one", () => {
    const withBundle = html("```mermaid\ngraph TD; A-->B\n```\n", {
      mermaidScript: "window.__m=1",
    });
    expect(withBundle).toContain(
      '<pre class="mermaid">graph TD; A--&gt;B</pre>',
    );
    expect(withBundle).toContain("<script>window.__m=1</script>");
    expect(withBundle).toContain("mermaid.render(");
    expect(withBundle).not.toContain('data-weaver-ready="true"');
    const noBlocks = html("Plain.\n", { mermaidScript: "window.__m=1" });
    expect(noBlocks).toContain('data-weaver-ready="true"');
    expect(noBlocks).not.toContain("window.__m=1");
    const noBundle = html("```mermaid\ngraph TD; A-->B\n```\n");
    expect(noBundle).toContain('data-weaver-ready="true"');
    expect(noBundle).toContain("<pre><code>graph TD; A--&gt;B</code></pre>");
  });

  it("refuses a Mermaid bundle that would close the script tag", () => {
    expect(() =>
      html("```mermaid\ngraph TD; A-->B\n```\n", {
        mermaidScript: "x</script><script>alert(1)",
      }),
    ).toThrow("closing script tag");
  });

  it("is deterministic for the same input", () => {
    expect(html("Same.\n")).toBe(html("Same.\n"));
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});
