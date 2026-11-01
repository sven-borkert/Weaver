import type { JSONContent } from "@tiptap/core";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type CrossrefTarget = {
  targetType: "document" | "table";
  targetId: string;
};

export function extractCrossrefTargets(doc: JSONContent): CrossrefTarget[] {
  const seen = new Set<string>();
  const out: CrossrefTarget[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === "crossref") {
      const attrs: unknown = node.attrs;
      const id =
        typeof attrs === "object" && attrs !== null && "targetId" in attrs
          ? attrs.targetId
          : undefined;
      const targetType =
        typeof attrs === "object" &&
        attrs !== null &&
        (attrs as { targetType?: unknown }).targetType === "table"
          ? ("table" as const)
          : ("document" as const);
      if (typeof id === "string" && UUID_RE.test(id)) {
        const key = `${targetType}:${id}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ targetType, targetId: id });
        }
      }
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return out;
}
