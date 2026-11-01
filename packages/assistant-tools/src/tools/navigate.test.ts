import { sourceLocatorSchema } from "@weaver/core/assistant/citations";
import {
  cursorQueryIdentity,
  decodeContentCursor,
} from "@weaver/core/services/contentCursors";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_OUTPUT_CHARS, type ToolContext } from "../contract";
import { navigateDocumentTool } from "./navigate";

const getDocumentAtSnapshot = vi.hoisted(() => vi.fn());
vi.mock("@weaver/core/services/documents", () => ({ getDocumentAtSnapshot }));

const projectId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const snapshotCommitSha = "a".repeat(40);
const baseCommitSha = "b".repeat(40);
const ctx = {
  db: {},
  actor: {},
  scope: { projectIds: [projectId] },
} as unknown as ToolContext;

function serve(markdown: string) {
  getDocumentAtSnapshot.mockResolvedValue({
    id: documentId,
    path: "docs/guide.md",
    title: "Guide",
    markdown,
    snapshotCommitSha,
    baseCommitSha,
  });
}

async function navigate(input: Record<string, unknown>) {
  return navigateDocumentTool.execute(
    navigateDocumentTool.inputSchema.parse({ projectId, documentId, ...input }),
    ctx,
  );
}

async function sectionIds() {
  const { output } = await navigate({ mode: "outline" });
  if (!("sections" in output)) throw new Error("expected an outline");
  return Object.fromEntries(output.sections.map((s) => [s.heading, s.id]));
}

const markdown = [
  "# Guide",
  "intro needle",
  "## Setup",
  "setup needle one, setup needle two",
  "#### Deep detail",
  "deep needle",
  "### Install",
  "install needle",
  "## Usage",
  "usage text",
].join("\n");

beforeAll(() => {
  process.env.AUTH_SECRET ??= "unit-test-cursor-secret";
});
beforeEach(() => getDocumentAtSnapshot.mockReset());

describe("navigate_document citations", () => {
  it("cites the section with its ancestor heading path", async () => {
    serve(markdown);
    const ids = await sectionIds();
    const outcome = await navigate({ mode: "section", sectionId: ids.Install });
    expect(outcome.citations).toEqual([
      {
        kind: "document",
        projectId,
        documentId,
        commitSha: baseCommitSha,
        headingPath: ["Guide", "Setup", "Install"],
        excerpt: null,
      },
    ]);
    expect(sourceLocatorSchema.safeParse(outcome.citations![0]).success).toBe(
      true,
    );
  });

  it("emits no citation for an outline", async () => {
    serve(markdown);
    expect((await navigate({ mode: "outline" })).citations).toBeUndefined();
  });

  it("cites each distinct matched section once, with the first excerpt", async () => {
    serve(`preamble needle\n${markdown}`);
    const outcome = await navigate({ mode: "find", find: "needle" });
    if (!("matches" in outcome.output)) throw new Error("expected matches");
    expect(outcome.output.matches).toHaveLength(6);
    expect(
      outcome.citations!.map((c) => "headingPath" in c && c.headingPath),
    ).toEqual([
      [],
      ["Guide"],
      ["Guide", "Setup"],
      ["Guide", "Setup", "Deep detail"],
      ["Guide", "Setup", "Install"],
    ]);
    const setup = outcome.citations![2]!;
    expect("excerpt" in setup && setup.excerpt).toBe(
      outcome.output.matches[2]!.excerpt,
    );
    for (const citation of outcome.citations!)
      expect(sourceLocatorSchema.safeParse(citation).success).toBe(true);
  });

  it("clamps locator fields to the schema instead of losing the citation", async () => {
    const long = "H".repeat(300);
    serve(`# ${long}\n${"needle ".repeat(200)}`);
    const found = await navigate({ mode: "find", find: "needle ".repeat(100) });
    expect(found.citations!.length).toBeGreaterThan(0);
    for (const citation of found.citations!) {
      const parsed = sourceLocatorSchema.safeParse(citation);
      expect(parsed.success).toBe(true);
      expect("headingPath" in citation && citation.headingPath).toEqual([
        "H".repeat(200),
      ]);
    }
  });
});

describe("navigate_document section paging", () => {
  it("fits an escape-dense section under a quote-dense heading to the transport cap and reassembles it", async () => {
    const heading = '"'.repeat(3_000);
    const body = `# ${heading}\n${'"\\\n'.repeat(7_000)}😀 end`;
    serve(body);
    const { output: outline } = await navigate({ mode: "outline" });
    if (!("sections" in outline)) throw new Error("expected an outline");
    const sectionId = outline.sections[0]!.id;

    let collected = "";
    let cursor: string | undefined;
    let calls = 0;
    do {
      calls += 1;
      expect(calls).toBeLessThan(20);
      const outcome = await navigate({ mode: "section", sectionId, cursor });
      const output = outcome.output;
      if (!("text" in output)) throw new Error("expected a section");
      expect(
        JSON.stringify({ output, citations: outcome.citations }).length,
      ).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
      expect(output.heading).toBe('"'.repeat(200));
      expect(output.text.length).toBeGreaterThan(0);
      collected += output.text;
      expect(output.hasMore).toBe(output.nextCursor !== null);
      expect(outcome.citations).toHaveLength(1);
      cursor = output.nextCursor ?? undefined;
      if (cursor)
        expect(
          decodeContentCursor(cursor, {
            kind: "document",
            projectId,
            resourceId: documentId,
            query: cursorQueryIdentity({
              mode: "section",
              sectionId,
              find: null,
            }),
          }).position,
        ).toBe(collected.length);
    } while (cursor);
    expect(calls).toBeGreaterThan(2);
    expect(collected).toBe(body);
  });
});
