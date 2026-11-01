import { getSchema } from "@tiptap/core";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { renderDocumentContent } from "~/lib/editor/render";
import {
  CodeBlockCopyButton,
  CodeBlockWithCopy,
  documentCodeBlockMapping,
} from "./DocumentCodeBlock";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const code = 'const a = "<b>";\n  return a;';

describe("CodeBlockCopyButton", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<CodeBlockCopyButton getText={() => code} />);
    });
    return renderer.root.findByType("button");
  };
  const click = (button: ReturnType<typeof render>) =>
    act(async () => (button.props.onClick as () => void)());

  it("copies the block text and shows the copied state for two seconds", async () => {
    const button = render();
    expect(button.props["aria-label"]).toBe("Copy code");
    await click(button);
    expect(writeText).toHaveBeenCalledWith(code);
    expect(button.props["aria-label"]).toBe("Copied");
    act(() => void vi.advanceTimersByTime(2000));
    expect(button.props["aria-label"]).toBe("Copy code");
  });

  it("reports a rejected or missing clipboard", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const button = render();
    await click(button);
    expect(toast.error).toHaveBeenCalledWith("Copy failed");
    expect(button.props["aria-label"]).toBe("Copy code");
    vi.stubGlobal("navigator", {});
    await click(button);
    expect(toast.error).toHaveBeenLastCalledWith(
      "Copy failed — clipboard is not available here",
    );
  });
});

describe("documentCodeBlockMapping", () => {
  it("keeps the code markup and adds the button", () => {
    const html = renderToStaticMarkup(
      renderDocumentContent(
        {
          type: "doc",
          content: [
            {
              type: "codeBlock",
              attrs: { language: "ts" },
              content: [{ type: "text", text: code }],
            },
            { type: "codeBlock", content: [{ type: "text", text: "plain" }] },
          ],
        },
        documentCodeBlockMapping,
      ),
    );
    expect(html).toContain(
      '<pre><code class="language-ts">const a = &quot;&lt;b&gt;&quot;;\n  return a;</code></pre>',
    );
    expect(html).toContain("<pre><code>plain</code></pre>");
    expect(html.match(/aria-label="Copy code"/g)).toHaveLength(2);
  });
});

describe("CodeBlockWithCopy", () => {
  it("leaves the code block schema unchanged", () => {
    const spec = (extensions: ReturnType<typeof documentExtensions>) => {
      const {
        toDOM: _toDOM,
        parseDOM: _parseDOM,
        ...rest
      } = getSchema(extensions).nodes.codeBlock!.spec;
      return JSON.stringify(rest);
    };
    expect(spec(documentExtensions({ codeBlock: CodeBlockWithCopy }))).toBe(
      spec(documentExtensions()),
    );
  });
});
