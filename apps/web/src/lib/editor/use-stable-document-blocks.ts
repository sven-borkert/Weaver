import type { JSONContent } from "@tiptap/core";
import { useState, type ReactNode } from "react";
import { renderDocumentBlocks } from "./render";

type BlockCache = {
  content: JSONContent;
  elements: Map<string, ReactNode>;
  blocks: ReactNode[];
};

function nextBlocks(
  content: JSONContent,
  previous: Map<string, ReactNode> | undefined,
): BlockCache {
  const rendered = renderDocumentBlocks(content);
  const json = content.content ?? [];
  const elements = new Map<string, ReactNode>();
  if (rendered.length !== json.length)
    return { content, elements, blocks: rendered };
  const blocks = rendered.map((element, index) => {
    const id = `${index}:${JSON.stringify(json[index])}`;
    const kept = previous?.get(id) ?? element;
    elements.set(id, kept);
    return kept;
  });
  return { content, elements, blocks };
}

/** Reuses unchanged blocks' elements so React keeps their DOM; `content` must be memoized. */
export function useStableDocumentBlocks(content: JSONContent): ReactNode[] {
  const [cache, setCache] = useState<BlockCache | null>(null);
  if (cache?.content === content) return cache.blocks;
  const next = nextBlocks(content, cache?.elements);
  setCache(next);
  return next.blocks;
}
