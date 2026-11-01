export type DocumentSectionNavigation = {
  section: string;
  sourceCommitSha: string;
  /** Counts in-page jumps (Contents tab) so repeating one scrolls again. */
  jump?: number;
};

export type DocumentSectionAnnouncement = {
  key: string;
  message: string;
};

export type DocumentSectionNavigationFeedback = {
  handledNavigationKey: string | undefined;
  announcement: DocumentSectionAnnouncement | undefined;
};

type DocumentSectionHighlightTarget = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

type DocumentSectionHighlightTimers = {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
};

const sectionPattern =
  /^section(?:-[\p{L}\p{N}]+)*(?:--[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)*$/u;
const sourceCommitShaPattern = /^[a-f0-9]{40}$/;

export function parseDocumentSectionNavigation(
  params: Record<string, string | string[] | undefined>,
): DocumentSectionNavigation | undefined {
  const section = params.section;
  const sourceCommitSha = params.source;
  if (
    typeof section !== "string" ||
    Array.from(section).length > 180 ||
    !sectionPattern.test(section) ||
    typeof sourceCommitSha !== "string" ||
    !sourceCommitShaPattern.test(sourceCommitSha)
  ) {
    return undefined;
  }

  return { section, sourceCommitSha };
}

export function documentSectionHref(input: {
  projectId: string;
  documentId: string;
  navigation?: DocumentSectionNavigation;
}): string {
  const href = `/projects/${encodeURIComponent(input.projectId)}/documents/${encodeURIComponent(input.documentId)}`;
  if (!input.navigation) return href;

  const query = new URLSearchParams();
  query.set("section", input.navigation.section);
  query.set("source", input.navigation.sourceCommitSha);
  return `${href}?${query.toString()}`;
}

export function documentSectionNavigationKey(
  documentId: string,
  navigation: DocumentSectionNavigation,
): string {
  const key = `${documentId}:${navigation.section}:${navigation.sourceCommitSha}`;
  return navigation.jump === undefined ? key : `${key}:${navigation.jump}`;
}

export function sectionScrollBlock(
  navigation: DocumentSectionNavigation,
): ScrollLogicalPosition {
  return navigation.jump === undefined ? "center" : "start";
}

export function resolveDocumentSectionTarget(input: {
  requested: DocumentSectionNavigation;
  currentSourceSha: string;
  targetExists: boolean;
}): { target: "section" | "article"; stale: boolean } {
  return {
    target: input.targetExists ? "section" : "article",
    stale: input.requested.sourceCommitSha !== input.currentSourceSha,
  };
}

export function sectionScrollBehavior(
  prefersReducedMotion: boolean,
): ScrollBehavior {
  return prefersReducedMotion ? "auto" : "smooth";
}

export function resolveDocumentSectionFeedback(input?: {
  navigationKey: string;
  target: "section" | "article";
}): DocumentSectionNavigationFeedback {
  if (!input) {
    return { handledNavigationKey: undefined, announcement: undefined };
  }

  return {
    handledNavigationKey: input.navigationKey,
    announcement:
      input.target === "article"
        ? {
            key: input.navigationKey,
            message:
              "The matching section changed. Showing the current document.",
          }
        : undefined,
  };
}

export function startDocumentSectionHighlight(
  target: DocumentSectionHighlightTarget,
  timers: DocumentSectionHighlightTimers,
): () => void {
  target.setAttribute("data-section-highlight", "true");
  const timeout = timers.setTimeout(() => {
    target.removeAttribute("data-section-highlight");
  }, 1_500);

  return () => {
    timers.clearTimeout(timeout);
    target.removeAttribute("data-section-highlight");
  };
}

/** `?version=<sha>` opens the document compared against that saved version. */
export function parseDocumentVersion(
  params: Record<string, string | string[] | undefined>,
): string | undefined {
  const version = params.version;
  return typeof version === "string" && sourceCommitShaPattern.test(version)
    ? version
    : undefined;
}

export function documentVersionHref(input: {
  projectId: string;
  documentId: string;
  versionSha: string;
}): string {
  return `/projects/${input.projectId}/documents/${input.documentId}?version=${input.versionSha}`;
}
