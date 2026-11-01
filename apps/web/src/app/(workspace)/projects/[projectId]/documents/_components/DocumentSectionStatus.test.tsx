import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  resolveDocumentSectionFeedback,
  resolveDocumentSectionTarget,
} from "~/lib/documents/section-navigation";
import { DocumentSectionStatus } from "./DocumentSectionStatus";

describe("DocumentSectionStatus", () => {
  it("presents a visible polite status when a requested section is missing", () => {
    const navigationKey = "document-1:section-removed:source-1";
    const target = resolveDocumentSectionTarget({
      requested: {
        section: "section-removed",
        sourceCommitSha: "a".repeat(40),
      },
      currentSourceSha: "b".repeat(40),
      targetExists: false,
    });
    const feedback = resolveDocumentSectionFeedback({
      navigationKey,
      target: target.target,
    });

    expect(target.target).toBe("article");
    const markup = renderToStaticMarkup(
      <DocumentSectionStatus
        announcement={feedback.announcement}
        navigationKey={navigationKey}
      />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain(
      "The matching section changed. Showing the current document.",
    );
    expect(markup).not.toContain("sr-only");
    expect(markup).not.toContain("hidden");
  });

  it("does not present feedback from a superseded navigation key", () => {
    expect(
      renderToStaticMarkup(
        <DocumentSectionStatus
          announcement={{
            key: "old-navigation",
            message:
              "The matching section changed. Showing the current document.",
          }}
          navigationKey="current-navigation"
        />,
      ),
    ).toBe("");
  });
});
