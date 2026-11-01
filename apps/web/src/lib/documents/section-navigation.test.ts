import { describe, expect, it } from "vitest";
import {
  documentSectionHref,
  documentSectionNavigationKey,
  documentVersionHref,
  parseDocumentSectionNavigation,
  parseDocumentVersion,
  resolveDocumentSectionFeedback,
  resolveDocumentSectionTarget,
  sectionScrollBehavior,
  sectionScrollBlock,
  startDocumentSectionHighlight,
} from "./section-navigation";

const sha = "a".repeat(40);

describe("document section navigation", () => {
  it("parses and serializes a bounded section destination", () => {
    const navigation = parseDocumentSectionNavigation({
      section: "section-deploy-2",
      source: sha,
    });

    expect(navigation).toEqual({
      section: "section-deploy-2",
      sourceCommitSha: sha,
    });
    expect(
      documentSectionHref({ projectId: "p 1", documentId: "d/1", navigation }),
    ).toBe(
      `/projects/p%201/documents/d%2F1?section=section-deploy-2&source=${sha}`,
    );
  });

  it("accepts safe Unicode section components at the 180-code-point bound", () => {
    const section = `section-${"é".repeat(172)}`;

    expect(parseDocumentSectionNavigation({ section, source: sha })).toEqual({
      section,
      sourceCommitSha: sha,
    });
  });

  it.each([
    [{ section: "<script>", source: sha }],
    [{ section: "section-deploy", source: "A".repeat(40) }],
    [{ section: "section-deploy", source: "a".repeat(39) }],
    [{ section: ["section-deploy"], source: sha }],
    [{ section: "section-deploy", source: [sha] }],
    [{ section: `section-${"a".repeat(173)}`, source: sha }],
    [{ section: "section-deploy" }],
    [{ source: sha }],
  ])("rejects invalid or incomplete query state %#", (params) => {
    expect(parseDocumentSectionNavigation(params)).toBeUndefined();
  });

  it("omits both query parameters without section navigation", () => {
    expect(documentSectionHref({ projectId: "p 1", documentId: "d/1" })).toBe(
      "/projects/p%201/documents/d%2F1",
    );
  });

  it("resolves current, stale, and missing section targets", () => {
    expect(
      resolveDocumentSectionTarget({
        requested: { section: "section-deploy", sourceCommitSha: sha },
        currentSourceSha: sha,
        targetExists: true,
      }),
    ).toEqual({ target: "section", stale: false });
    expect(
      resolveDocumentSectionTarget({
        requested: { section: "section-deploy", sourceCommitSha: sha },
        currentSourceSha: "b".repeat(40),
        targetExists: true,
      }),
    ).toEqual({ target: "section", stale: true });
    expect(
      resolveDocumentSectionTarget({
        requested: { section: "section-deploy", sourceCommitSha: sha },
        currentSourceSha: sha,
        targetExists: false,
      }),
    ).toEqual({ target: "article", stale: false });
    expect(
      resolveDocumentSectionTarget({
        requested: { section: "section-deploy", sourceCommitSha: sha },
        currentSourceSha: "b".repeat(40),
        targetExists: false,
      }),
    ).toEqual({ target: "article", stale: true });
  });

  it("keys each in-page jump separately so repeating one scrolls again", () => {
    const navigation = { section: "section-deploy", sourceCommitSha: sha };
    expect(documentSectionNavigationKey("document-1", navigation)).toBe(
      `document-1:section-deploy:${sha}`,
    );
    expect(
      documentSectionNavigationKey("document-1", { ...navigation, jump: 2 }),
    ).toBe(`document-1:section-deploy:${sha}:2`);
  });

  it("centers deep-linked sections and puts in-page jumps at the top", () => {
    const navigation = { section: "section-deploy", sourceCommitSha: sha };
    expect(sectionScrollBlock(navigation)).toBe("center");
    expect(sectionScrollBlock({ ...navigation, jump: 1 })).toBe("start");
  });

  it("uses instant scrolling when reduced motion is preferred", () => {
    expect(sectionScrollBehavior(true)).toBe("auto");
    expect(sectionScrollBehavior(false)).toBe("smooth");
  });

  it("keys repeated missing-section announcements and clears absent navigation", () => {
    const first = resolveDocumentSectionFeedback({
      navigationKey: "document-1:section-first:source-1",
      target: "article",
    });
    const second = resolveDocumentSectionFeedback({
      navigationKey: "document-1:section-second:source-2",
      target: "article",
    });

    expect(first).toEqual({
      handledNavigationKey: "document-1:section-first:source-1",
      announcement: {
        key: "document-1:section-first:source-1",
        message: "The matching section changed. Showing the current document.",
      },
    });
    expect(second.announcement?.message).toBe(first.announcement?.message);
    expect(second.announcement?.key).not.toBe(first.announcement?.key);
    expect(
      resolveDocumentSectionFeedback({
        navigationKey: "document-1:section-live:source-3",
        target: "section",
      }),
    ).toEqual({
      handledNavigationKey: "document-1:section-live:source-3",
      announcement: undefined,
    });
    expect(resolveDocumentSectionFeedback()).toEqual({
      handledNavigationKey: undefined,
      announcement: undefined,
    });
  });

  it("removes a section highlight and cancels its timer during cleanup", () => {
    const attributes = new Map<string, string>();
    let scheduledDelay: number | undefined;
    let scheduledCallback: (() => void) | undefined;
    let cancelledTimer: number | undefined;
    const cleanup = startDocumentSectionHighlight(
      {
        setAttribute(name, value) {
          attributes.set(name, value);
        },
        removeAttribute(name) {
          attributes.delete(name);
        },
      },
      {
        setTimeout(callback, delay) {
          scheduledCallback = callback;
          scheduledDelay = delay;
          return 42;
        },
        clearTimeout(timer) {
          cancelledTimer = timer;
        },
      },
    );

    expect(attributes.get("data-section-highlight")).toBe("true");
    expect(scheduledDelay).toBe(1_500);
    expect(scheduledCallback).toBeTypeOf("function");
    cleanup();
    expect(cancelledTimer).toBe(42);
    expect(attributes.has("data-section-highlight")).toBe(false);
  });
});

describe("document version deep link", () => {
  const sha = "a".repeat(40);

  it("round-trips a saved commit and ignores anything that is not one", () => {
    const href = documentVersionHref({
      projectId: "p",
      documentId: "d",
      versionSha: sha,
    });
    expect(href).toBe(`/projects/p/documents/d?version=${sha}`);
    expect(parseDocumentVersion({ version: sha })).toBe(sha);
    for (const version of [
      undefined,
      "abc",
      [sha],
      `${sha}0`,
      sha.toUpperCase(),
    ])
      expect(parseDocumentVersion({ version })).toBeUndefined();
  });
});
