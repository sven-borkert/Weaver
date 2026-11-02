import type { JSONContent } from "@tiptap/core";
import { parseDocumentBody, serializeDocumentBody } from "../editor/markdown";
import { CoreError } from "../errors";
import { trackedLink } from "./links";

export type AgentLinkTarget = { id: string; title: string };

/** Live pages only; byTitle matches by normalized title and skips source pages. */
export type AgentLinkResolver = {
  byTitle(title: string): Promise<AgentLinkTarget[]>;
  byPath(path: string): Promise<AgentLinkTarget | null>;
  exists(
    kind: "document" | "table",
    id: string,
  ): Promise<{ title: string } | null>;
};

export type UnresolvedLink = {
  target: string;
  reason: "ambiguous" | "not_found" | "too_many_links";
};
export type InvalidLink = {
  target: string;
  reason: "near_miss" | "unknown_target" | "unverified";
};
export type PreprocessedMarkdown = {
  markdown: string;
  unresolvedLinks: UnresolvedLink[];
  invalidLinks: InvalidLink[];
};

const MAX_RESOLVED_TARGETS = 200;
const MAX_REPORTED_TARGET_CHARS = 300;
const MAX_DEMOTION_ROUNDS = 4;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TRACKED_RE = new RegExp(`^weaver://(document|table)/(${UUID})$`);
const NEAR_MISS_RE = /^\s*weaver:/i;
const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i;
const LINK_RE =
  /\[\[([^\[\]\r\n|]{1,300})\]\]|(?<!!)\[((?:\\.|[^\[\]\\\r\n])*)\]\(([^()\s]+)\)/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN_RE = /(`+)(?:(?!\1)[\s\S])*?\1(?!`)/g;

function resolveRelativePath(
  folderPath: readonly string[],
  href: string,
): string | null {
  const segments = href.startsWith("/") ? [] : [...folderPath];
  for (const part of href.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.join("/");
}

function decoded(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

function bounded(target: string): string {
  return target.slice(0, MAX_REPORTED_TARGET_CHARS);
}

/** Code stays literal: only prose segments are candidates. */
function splitProse(markdown: string): Array<{ text: string; prose: boolean }> {
  const parts: Array<{ text: string; prose: boolean }> = [];
  const lines = markdown.split(/(?<=\n)/);
  let fence: string | null = null;
  let buffer = "";
  const flushProse = () => {
    if (!buffer) return;
    let last = 0;
    for (const span of buffer.matchAll(CODE_SPAN_RE)) {
      parts.push({ text: buffer.slice(last, span.index), prose: true });
      parts.push({ text: span[0], prose: false });
      last = span.index + span[0].length;
    }
    parts.push({ text: buffer.slice(last), prose: true });
    buffer = "";
  };
  for (const line of lines) {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence !== null) {
      parts.push({ text: line, prose: false });
      if (marker?.startsWith(fence.charAt(0)) && marker.length >= fence.length)
        fence = null;
      continue;
    }
    if (marker) {
      flushProse();
      fence = marker;
      parts.push({ text: line, prose: false });
      continue;
    }
    buffer += line;
  }
  flushProse();
  return parts;
}

function demote(
  node: JSONContent,
  parent: string,
  verified: ReadonlySet<string>,
  invalid: InvalidLink[],
): JSONContent[] {
  const report = (target: string) =>
    invalid.push({ target: bounded(target), reason: "unverified" });
  const textNode = (text: string): JSONContent[] =>
    text ? [{ type: "text", text }] : [];
  if (node.type === "crossref") {
    const type = node.attrs?.targetType === "table" ? "table" : "document";
    const id = String(node.attrs?.targetId);
    if (verified.has(`${type}:${id}`)) return [node];
    report(`weaver://${type}/${id}`);
    return textNode(String(node.attrs?.label ?? "Untitled"));
  }
  if (node.type === "image" && NEAR_MISS_RE.test(String(node.attrs?.src))) {
    report(String(node.attrs?.src));
    const text = textNode(String(node.attrs?.alt ?? "") || "image");
    // A lifted image sits between blocks, where bare text is not valid.
    return parent === "doc" ? [{ type: "paragraph", content: text }] : text;
  }
  const next: JSONContent = { ...node };
  if (node.marks) {
    next.marks = node.marks.filter((mark) => {
      const href = mark.type === "link" ? String(mark.attrs?.href) : "";
      if (!NEAR_MISS_RE.test(href)) return true;
      const tracked = TRACKED_RE.exec(href);
      if (tracked && verified.has(`${tracked[1]}:${tracked[2]}`)) return true;
      report(href);
      return false;
    });
    if (next.marks.length === 0) delete next.marks;
  }
  if (node.content)
    next.content = node.content.flatMap((child) =>
      demote(child, node.type ?? "", verified, invalid),
    );
  return [next];
}

/**
 * What the writer's own parser sees is what counts: regexes cannot agree with it on
 * every destination form, and stripping a link can re-form another one.
 */
function demoteUnverifiedLinks(
  markdown: string,
  verified: ReadonlySet<string>,
  maxRounds: number,
): { markdown: string; invalid: InvalidLink[] } {
  const invalid: InvalidLink[] = [];
  let current = markdown;
  for (let round = 0; round < maxRounds; round++) {
    const found: InvalidLink[] = [];
    let demoted: JSONContent | undefined;
    try {
      [demoted] = demote(parseDocumentBody(current), "", verified, found);
    } catch {
      throw unstableLinks();
    }
    if (found.length === 0) return { markdown: current, invalid };
    invalid.push(...found);
    const serialized = serializeDocumentBody(demoted!);
    current = markdown.endsWith("\n")
      ? serialized
      : serialized.replace(/\n$/, "");
  }
  // Only a clean parse of the final text may leave this function.
  throw unstableLinks();
}

function unstableLinks(): CoreError {
  return new CoreError(
    "BAD_REQUEST",
    "The Markdown's links could not be verified; rewrite them as [Title](weaver://document/<id>) with an id a tool returned",
    { reason: "UNVERIFIABLE_LINKS" },
  );
}

/** Every weaver: target the writer's parser finds, tracked or not. */
export function weaverLinkTargets(markdown: string): string[] {
  const found: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "crossref")
      found.push(
        `weaver://${node.attrs?.targetType === "table" ? "table" : "document"}/${String(node.attrs?.targetId)}`,
      );
    if (node.type === "image" && NEAR_MISS_RE.test(String(node.attrs?.src)))
      found.push(String(node.attrs?.src));
    for (const mark of node.marks ?? []) {
      const href = mark.type === "link" ? String(mark.attrs?.href) : "";
      if (NEAR_MISS_RE.test(href)) found.push(href);
    }
    node.content?.forEach(walk);
  };
  walk(parseDocumentBody(markdown));
  return found;
}

export function parseTrackedTarget(
  target: string,
): { kind: "document" | "table"; id: string } | null {
  const tracked = TRACKED_RE.exec(target);
  return tracked
    ? { kind: tracked[1] as "document" | "table", id: tracked[2]! }
    : null;
}

/** Turns the agent's link forms into tracked links; nothing unresolved becomes a link. */
export async function preprocessAgentMarkdown(
  markdown: string,
  resolver: AgentLinkResolver,
  options: { folderPath: readonly string[]; maxDemotionRounds?: number },
): Promise<PreprocessedMarkdown> {
  const unresolvedLinks: UnresolvedLink[] = [];
  const invalidLinks: InvalidLink[] = [];
  const cache = new Map<string, Promise<unknown>>();
  const verified = new Set<string>();
  let lookups = 0;
  const remember = <T>(
    key: string,
    load: () => Promise<T>,
  ): Promise<T> | null => {
    const known = cache.get(key) as Promise<T> | undefined;
    if (known) return known;
    if (lookups >= MAX_RESOLVED_TARGETS) return null;
    lookups += 1;
    const pending = load();
    cache.set(key, pending);
    return pending;
  };
  const refuseOverBudget = (target: string) =>
    unresolvedLinks.push({
      target: bounded(target),
      reason: "too_many_links",
    });

  const rewrite = async (
    match: RegExpExecArray | RegExpMatchArray,
  ): Promise<string> => {
    const [whole, wikilink, label, href] = match;
    if (wikilink !== undefined) {
      const title = wikilink.trim();
      const lookup = remember(`t:${title}`, () => resolver.byTitle(title));
      if (lookup === null) {
        refuseOverBudget(title);
        return whole;
      }
      const hits = await lookup;
      if (hits.length === 1) {
        verified.add(`document:${hits[0]!.id}`);
        return trackedLink("document", hits[0]!.id, hits[0]!.title);
      }
      unresolvedLinks.push({
        target: bounded(title),
        reason: hits.length === 0 ? "not_found" : "ambiguous",
      });
      return whole;
    }
    const target = href!;
    const tracked = TRACKED_RE.exec(target);
    if (tracked) {
      const kind = tracked[1] as "document" | "table";
      const lookup = remember(`e:${kind}:${tracked[2]}`, () =>
        resolver.exists(kind, tracked[2]!),
      );
      if (lookup === null) {
        refuseOverBudget(target);
        return label!;
      }
      if (await lookup) {
        verified.add(`${kind}:${tracked[2]}`);
        return whole;
      }
      invalidLinks.push({ target: bounded(target), reason: "unknown_target" });
      return label!;
    }
    if (NEAR_MISS_RE.test(target)) {
      invalidLinks.push({ target: bounded(target), reason: "near_miss" });
      return label!;
    }
    if (EXTERNAL_RE.test(target) || !/\.md(?:#.*)?$/i.test(target))
      return whole;
    const path = resolveRelativePath(
      options.folderPath,
      decoded(target.replace(/#.*$/, "")),
    );
    if (path === null) {
      unresolvedLinks.push({ target: bounded(target), reason: "not_found" });
      return label!;
    }
    const lookup = remember(`p:${path}`, () => resolver.byPath(path));
    if (lookup === null) {
      refuseOverBudget(target);
      return label!;
    }
    const hit = await lookup;
    if (hit) {
      verified.add(`document:${hit.id}`);
      return trackedLink("document", hit.id, hit.title);
    }
    unresolvedLinks.push({ target: bounded(target), reason: "not_found" });
    return label!;
  };

  const out: string[] = [];
  for (const part of splitProse(markdown)) {
    if (!part.prose) {
      out.push(part.text);
      continue;
    }
    let last = 0;
    for (const match of part.text.matchAll(LINK_RE)) {
      out.push(part.text.slice(last, match.index));
      out.push(await rewrite(match));
      last = match.index + match[0].length;
    }
    out.push(part.text.slice(last));
  }
  const checked = demoteUnverifiedLinks(
    out.join(""),
    verified,
    options.maxDemotionRounds ?? MAX_DEMOTION_ROUNDS,
  );
  invalidLinks.push(...checked.invalid);
  return { markdown: checked.markdown, unresolvedLinks, invalidLinks };
}
