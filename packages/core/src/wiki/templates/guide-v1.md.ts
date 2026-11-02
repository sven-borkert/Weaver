export const GUIDE_TEMPLATE_VERSION = 1;

export const GUIDE_TITLE = "Wiki guide";
export const OVERVIEW_TITLE = "Overview";

export const OVERVIEW_TEMPLATE = `This is the front page of the project wiki. The wiki agent keeps a short summary of what the wiki covers here once it has processed its first inputs.
`;

export const GUIDE_TEMPLATE_V1 = `This guide describes how this wiki is organized. It applies to every page the wiki agent writes. Maintainers approve it; the agent cannot change it and can only suggest changes.

## Purpose

The wiki turns raw inputs (notes and files) into a lasting body of linked pages. Raw inputs stay untouched as source pages. Wiki pages are the synthesis: short, factual, cross-referenced and kept current.

## Folders

- Keep every wiki page under the wiki folder.
- Source pages live in the sources folder. They are verbatim records. Never edit or move them.
- Group related pages in subfolders only when a topic has more than about ten pages.

## Page types

Every page the agent writes carries a type and a one-sentence summary in its properties.

- summary: one page per processed input. States what the input says and links to its source page.
- entity: a person, product, system, organization or other named thing.
- concept: an idea, term or method.
- topic: an area that gathers entity and concept pages.
- synthesis: a conclusion that draws on several pages, with its sources listed.
- overview: the front page. Only one exists.

## Naming

- Titles are short, specific nouns or noun phrases in sentence case.
- One page per subject. Search for an existing page before creating a new one, and update it instead of duplicating it.
- Use the singular form and the most common name. Mention aliases inside the page body.

## Writing

- Write plain, neutral, factual prose in the language of the input unless a reader would clearly prefer another.
- Prefer short paragraphs and lists. Put the most important point first.
- Attribute claims to their source page. State uncertainty openly.
- When new information contradicts an existing claim, keep both and note the contradiction with each source. Never silently replace a claim.
- Do not copy long passages from sources. Summarize and link.

## Linking

- Link related pages with the tracked link form that find_page returns. Link the first mention of a page in each section.
- Every summary page links to the pages it updated, and every updated page links back to the relevant summary page.
- Avoid orphans: each new page must be reachable from at least one other page.

## Ingest protocol

1. Read the input and its source page completely.
2. Search the wiki for related pages.
3. Create or update the summary page for the input.
4. Update the entity, concept, topic and synthesis pages the input touches, adding cross-references.
5. Finish the input as integrated, or as skipped with a reason when it holds nothing useful.

## Lint protocol

- Report orphan pages, links to missing pages, contradictions between pages and pages whose summary no longer fits their content.
- Fix only what is certain: missing cross-references and stale summaries. Report everything else in the lint report.
`;
