import type { JSONContent } from "@tiptap/core";
import { parseDocumentBody } from "@weaver/core/editor/markdown";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vitest";
import { useStableDocumentBlocks } from "./use-stable-document-blocks";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const renders: ReactNode[][] = [];
function Blocks({ content }: { content: JSONContent }) {
  const blocks = useStableDocumentBlocks(content);
  renders.push(blocks);
  return <div>{blocks}</div>;
}

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => tree?.unmount());
  renders.length = 0;
});

describe("useStableDocumentBlocks", () => {
  it("reuses the element of each unchanged block while later text streams in", async () => {
    await act(() => {
      tree = create(
        <Blocks content={parseDocumentBody("First answer line.\n\nSecond")} />,
      );
    });
    const before = renders.at(-1)!;
    await act(() =>
      tree!.update(
        <Blocks
          content={parseDocumentBody(
            "First answer line.\n\nSecond **bold**\n\n- item",
          )}
        />,
      ),
    );
    const after = renders.at(-1)!;

    expect(after).toHaveLength(3);
    // The same element object lets React keep the block's DOM and any selection in it.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(tree!.root.findAllByType("strong")).toHaveLength(1);

    await act(() =>
      tree!.update(
        <Blocks content={parseDocumentBody("Changed first line.\n\nSecond")} />,
      ),
    );
    expect(renders.at(-1)![0]).not.toBe(before[0]);
    expect(tree!.root.findAllByType("p")).toHaveLength(2);
  });
});
