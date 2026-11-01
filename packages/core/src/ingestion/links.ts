import { z } from "zod";
import { MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS } from "../knowledge/sectionAnchors";

export const MAX_PROPOSED_LINKS = 10;
export const MAX_LINK_QUERIES = 5;
export const MAX_LINK_QUERY_CHARS = 120;
export const LINK_EXCERPT_CHARS = 240;
export const LINK_KEEP_THRESHOLD = 0.6;
const MAX_QUERY_WORDS = 12;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu;

export const proposedLinkSchema = z.object({
  documentId: z.uuid(),
  title: z.string().max(200),
  anchor: z
    .string()
    .refine(
      (anchor) =>
        Array.from(anchor).length <= MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS,
      `Section anchors must be at most ${MAX_DOCUMENT_SECTION_ANCHOR_CHARACTERS} Unicode code points`,
    )
    .nullable(),
  confidence: z.number().min(0).max(1),
  excerpt: z.string().max(LINK_EXCERPT_CHARS),
  keep: z.boolean(),
});
export const proposedLinksSchema = z
  .array(proposedLinkSchema)
  .max(MAX_PROPOSED_LINKS);
export type ProposedLink = z.infer<typeof proposedLinkSchema>;

/** Distinct significant words joined with `or`, so websearch_to_tsquery matches any of them. */
export function linkQueryFor(text: string): string | null {
  const candidates = [
    ...new Set(
      (text.toLowerCase().match(WORD_RE) ?? []).map((word) =>
        word.replace(/-+$/, ""),
      ),
    ),
  ].filter((word) => word.length >= 4);
  const words: string[] = [];
  let queryLength = 0;
  for (const word of candidates) {
    if (words.length === MAX_QUERY_WORDS) break;
    const addedLength = word.length + (words.length === 0 ? 0 : " or ".length);
    if (queryLength + addedLength > MAX_LINK_QUERY_CHARS) continue;
    words.push(word);
    queryLength += addedLength;
  }
  return words.length > 0 ? words.join(" or ") : null;
}

export function headingsOf(markdown: string, max = 3): string[] {
  const headings: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]) headings.push(match[1]);
    if (headings.length === max) break;
  }
  return headings;
}

export type LinkCandidate = {
  documentId: string;
  title: string;
  navigationAnchor: string | null;
  content: string;
  rank?: number;
};

function excerptOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > LINK_EXCERPT_CHARS
    ? `${flat.slice(0, LINK_EXCERPT_CHARS - 1)}…`
    : flat;
}

/** Explicit exact-title hits score 1; other candidates scale 0.4–0.95 within their query. */
export function scoreLinkCandidates(
  perQuery: LinkCandidate[][],
  exactTitles: readonly (string | null)[] = [],
): ProposedLink[] {
  const best = new Map<string, ProposedLink>();
  for (const [queryIndex, results] of perQuery.entries()) {
    const top = Math.max(0, ...results.map((result) => result.rank ?? 0));
    for (const candidate of results) {
      const rank = candidate.rank ?? 0;
      const exactTitle = exactTitles[queryIndex]?.trim().toLocaleLowerCase();
      const confidence =
        exactTitle && candidate.title.trim().toLocaleLowerCase() === exactTitle
          ? 1
          : exactTitles.length === 0 && rank === 0
            ? 1
            : top === 0
              ? 0.4
              : Math.round((0.4 + 0.55 * (rank / top)) * 100) / 100;
      const current = best.get(candidate.documentId);
      if (current && current.confidence >= confidence) continue;
      best.set(candidate.documentId, {
        documentId: candidate.documentId,
        title: candidate.title.slice(0, 200),
        anchor: candidate.navigationAnchor,
        confidence,
        excerpt: excerptOf(candidate.content),
        keep: confidence >= LINK_KEEP_THRESHOLD,
      });
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        a.title.localeCompare(b.title) ||
        a.documentId.localeCompare(b.documentId),
    )
    .slice(0, MAX_PROPOSED_LINKS);
}

function escapeLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
}

/** Appends kept links as a Related section of typed cross-references (weaver-documents crossref syntax). */
export function withRelatedLinks(
  markdown: string,
  links: ProposedLink[],
): string {
  const kept = links.filter((link) => link.keep);
  if (kept.length === 0) return markdown;
  const items = kept.map(
    (link) =>
      `- [${escapeLabel(link.title || "Untitled")}](weaver://document/${link.documentId})`,
  );
  return `${markdown.replace(/\s+$/, "")}\n\n## Related\n\n${items.join("\n")}\n`;
}
