import { describe, expect, it } from "vitest";
import {
  classifyLookup,
  correlationFromParams,
  DEFAULT_FILTERS,
  toListInput,
} from "./eventFilters";

describe("event filters", () => {
  it("classifies a lookup value by shape", () => {
    expect(classifyLookup(" A3F9C2E1 ")).toEqual({ reference: "a3f9c2e1" });
    expect(classifyLookup("fe9d8418-03a9-4fbc-a3e0-c553700cc080")).toEqual({
      runId: "fe9d8418-03a9-4fbc-a3e0-c553700cc080",
    });
    expect(classifyLookup("req-123")).toEqual({ requestId: "req-123" });
    expect(classifyLookup("")).toBeNull();
  });

  it("excludes debug by default while allowing all severities explicitly", () => {
    expect(toListInput(DEFAULT_FILTERS, undefined)).toEqual({
      limit: 50,
      excludeDebug: true,
    });
    expect(
      toListInput({ ...DEFAULT_FILTERS, severity: "all" }, undefined),
    ).toEqual({ limit: 50 });
  });

  it.each(["debug", "info", "warn", "error"] as const)(
    "sends only the exact %s severity when selected",
    (severity) => {
      expect(toListInput({ ...DEFAULT_FILTERS, severity }, undefined)).toEqual({
        limit: 50,
        severity,
      });
    },
  );

  it("builds a list input with only the set filters", () => {
    expect(
      toListInput(
        {
          ...DEFAULT_FILTERS,
          severity: "error",
          category: "ai",
          since: "2026-09-12T10:00",
          lookup: "a3f9c2e1",
        },
        "cursor-1",
      ),
    ).toEqual({
      limit: 50,
      cursor: "cursor-1",
      severity: "error",
      category: "ai",
      since: new Date("2026-09-12T10:00"),
      reference: "a3f9c2e1",
    });
  });

  it("reads valid correlation ids from the URL and passes them to the list input", () => {
    const correlation = correlationFromParams(
      new URLSearchParams(
        "documentId=11111111-1111-4111-8111-111111111111&jobId=job-7",
      ),
    );
    expect(correlation).toEqual({
      documentId: "11111111-1111-4111-8111-111111111111",
      jobId: "job-7",
    });
    expect(toListInput(DEFAULT_FILTERS, undefined, correlation)).toEqual({
      limit: 50,
      excludeDebug: true,
      documentId: "11111111-1111-4111-8111-111111111111",
      jobId: "job-7",
    });
    expect(
      correlationFromParams(
        new URLSearchParams(`documentId=not-a-uuid&jobId=${"x".repeat(65)}`),
      ),
    ).toEqual({});
  });
});

it("preserves processing correlations while rejecting malformed identifiers", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(
    correlationFromParams(
      new URLSearchParams({
        projectId: id,
        generationId: id,
        runId: id,
        documentId: id,
        jobId: "job-1",
      }),
    ),
  ).toEqual({
    projectId: id,
    generationId: id,
    runId: id,
    documentId: id,
    jobId: "job-1",
  });
  expect(
    correlationFromParams(
      new URLSearchParams({
        projectId: "private text",
        generationId: "bad",
        runId: "bad",
      }),
    ),
  ).toEqual({});
});

it("carries a validated ingestion file correlation across attempts", () => {
  expect(
    correlationFromParams(
      new URLSearchParams({ fileId: "11111111-1111-4111-8111-111111111111" }),
    ),
  ).toEqual({ fileId: "11111111-1111-4111-8111-111111111111" });
  expect(
    correlationFromParams(new URLSearchParams({ fileId: "private file name" })),
  ).toEqual({});
});
