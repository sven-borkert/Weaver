import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GraphDetails } from "./GraphDetails";

describe("graph provenance labels", () => {
  it("identifies generated evidence as a model summary while retaining the source link", () => {
    const html = renderToStaticMarkup(
      <GraphDetails
        projectId="project"
        selection={{ kind: "relation", id: "relation" }}
        loading={false}
        failed={false}
        expansionAtCapacity={false}
        graphActionLoading={false}
        onRetry={() => undefined}
        onFocus={() => undefined}
        onExpand={() => undefined}
        onSelect={() => undefined}
        relationDetail={{
          relation: {
            relationId: "relation",
            projectId: "project",
            projectName: "Project",
            relationType: "uses",
            source: {
              entityId: "a",
              canonicalName: "A",
              entityType: "Concept",
              projectId: "project",
              projectName: "Project",
              aliases: [],
              description: null,
            },
            target: {
              entityId: "b",
              canonicalName: "B",
              entityType: "Concept",
              projectId: "project",
              projectName: "Project",
              aliases: [],
              description: null,
            },
          },
          evidence: [
            {
              evidenceId: "evidence",
              sourceCommitSha: "a".repeat(40),
              headingPath: [],
              excerpt: "Model claim",
              confidence: 0.9,
              validFrom: null,
              validTo: null,
              navigation: {
                documentId: "document",
                title: "Source",
                slug: "source",
                path: "source.md",
                navigationAnchor: null,
              },
            },
          ],
          truncated: false,
        }}
      />,
    );
    expect(html).toContain("Model-generated summary");
    expect(html).toContain("/projects/project/documents/document");
  });
});
