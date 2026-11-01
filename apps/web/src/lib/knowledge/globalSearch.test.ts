import { describe, expect, it } from "vitest";

import {
  flattenGlobalSearchOptions,
  globalSearchResponseIdentity,
  moveGlobalSearchActive,
  normalizeGlobalSearchProjectIds,
} from "./globalSearch";

const response = {
  documents: [
    {
      documentId: "document-a",
      projectId: "project-a",
      projectName: "Project A",
      sourceCommitSha: "a".repeat(40),
      title: "Deployment guide",
      path: "deployment-guide.md",
      headingPath: ["Deploy"],
      navigationAnchor: "section-deploy",
      snippet: "Deploy the service.",
    },
    {
      documentId: "document-b",
      projectId: "project-a",
      projectName: "Project A",
      sourceCommitSha: "b".repeat(40),
      title: "Introduction",
      path: "introduction.py",
      headingPath: [],
      navigationAnchor: null,
      snippet: "Start here.",
    },
  ],
  tables: [
    {
      tableId: "table-a",
      projectId: "project-a",
      projectName: "Project A",
      title: "Deployments",
      rowCount: 3,
      matchingColumns: ["Environment"],
    },
  ],
  entities: [
    {
      entityId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      projectName: "Project B",
      canonicalName: "Deployment",
      entityType: "Process",
      description: "A production deployment.",
      aliases: ["Release"],
    },
  ],
};

describe("global search presentation", () => {
  it("normalizes all-project and canonical bounded project scopes", () => {
    expect(normalizeGlobalSearchProjectIds([])).toBeUndefined();
    expect(
      normalizeGlobalSearchProjectIds(["project-b", "project-a", "project-b"]),
    ).toEqual(["project-a", "project-b"]);
    expect(
      normalizeGlobalSearchProjectIds(
        Array.from(
          { length: 52 },
          (_, index) => `project-${String(52 - index).padStart(3, "0")}`,
        ),
      ),
    ).toEqual(
      Array.from(
        { length: 50 },
        (_, index) => `project-${String(index + 1).padStart(3, "0")}`,
      ),
    );
  });

  it("flattens groups in stable order with type-specific destinations", () => {
    const options = flattenGlobalSearchOptions(response);

    expect(options.map((option) => option.kind)).toEqual([
      "document",
      "document",
      "table",
      "entity",
    ]);
    expect(options[0]?.href).toBe(
      `/projects/project-a/documents/document-a?section=section-deploy&source=${"a".repeat(40)}`,
    );
    expect(options[1]?.href).toBe("/projects/project-a/documents/document-b");
    expect(options[2]?.href).toBe("/projects/project-a/tables/table-a");
    expect(options[3]?.href).toBe(
      "/projects/22222222-2222-4222-8222-222222222222/graph?focus=11111111-1111-4111-8111-111111111111",
    );
  });

  it("creates a canonical identity from submitted query and scope", () => {
    expect(globalSearchResponseIdentity(" deploy ", ["b", "a"])).toBe(
      globalSearchResponseIdentity("deploy", ["a", "b"]),
    );
    expect(globalSearchResponseIdentity("deploy", [])).toBe(
      globalSearchResponseIdentity("deploy", undefined),
    );
  });

  it("moves through all groups with wrapped arrows and endpoint moves", () => {
    const options = flattenGlobalSearchOptions(response);

    expect(moveGlobalSearchActive(options, options[0]?.key, "previous")).toBe(
      options.at(-1)?.key,
    );
    expect(moveGlobalSearchActive(options, options.at(-1)?.key, "next")).toBe(
      options[0]?.key,
    );
    expect(moveGlobalSearchActive(options, undefined, "first")).toBe(
      options[0]?.key,
    );
    expect(moveGlobalSearchActive(options, undefined, "last")).toBe(
      options.at(-1)?.key,
    );
    expect(moveGlobalSearchActive(options, undefined, "previous")).toBe(
      options.at(-1)?.key,
    );
    expect(moveGlobalSearchActive([], undefined, "next")).toBeUndefined();
  });
});
