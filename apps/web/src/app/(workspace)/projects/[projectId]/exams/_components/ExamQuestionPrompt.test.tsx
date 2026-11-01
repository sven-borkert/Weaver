import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogTrigger: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));
import { ExamQuestionPrompt } from "./ExamQuestionPrompt";
it("makes every fenced example available in a dialog without dropping question text", () => {
  const html = renderToStaticMarkup(
    <ExamQuestionPrompt
      text={
        'What does this print?\n\n```python\nprint("hello")\n```\n\nExplain why.\n\n~~~js\nalert("world");\n~~~'
      }
    />,
  );
  expect(html).toContain("What does this print?");
  expect(html).toContain("Explain why.");
  expect(html.match(/View code example/g)).toHaveLength(2);
  expect(html.match(/role="dialog"/g)).toHaveLength(2);
  expect(html).toContain('class="language-python"');
  expect(html).toContain("print(&quot;hello&quot;)");
  expect(html).toContain("alert(&quot;world&quot;);");
});
it("preserves code inside nested Markdown and treats HTML as code", () => {
  const html = renderToStaticMarkup(
    <ExamQuestionPrompt
      text={"- Inspect this:\n\n  ```html\n  <script>alert(1)</script>\n  ```"}
    />,
  );
  expect(html).toContain("<ul");
  expect(html).toContain("View code example");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});
