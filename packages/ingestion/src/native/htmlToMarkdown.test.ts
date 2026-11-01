import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./htmlToMarkdown";

describe("htmlToMarkdown", () => {
  it("renders headings, lists, emphasis, and GFM tables", () => {
    const markdown = htmlToMarkdown(
      "<h1>Title</h1><p>Body <strong>bold</strong> and <em>em</em>.</p><ul><li>one</li><li>two</li></ul><table><tr><td>A</td><td>B</td></tr><tr><td>1|x</td><td>line<br>break</td></tr></table>",
    );
    expect(markdown).toBe(
      "# Title\n\nBody **bold** and _em_.\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1\\|x | line<br>break |\n",
    );
  });

  it("drops images without a source and collapses blank runs", () => {
    expect(htmlToMarkdown('<p>a</p><img src=""><p></p><p>b</p>')).toBe(
      "a\n\nb\n",
    );
  });

  it("keeps a manual line break outside a table as a Markdown hard break", () => {
    expect(htmlToMarkdown("<p>a<br>b</p>")).toBe("a  \nb\n");
  });
});
