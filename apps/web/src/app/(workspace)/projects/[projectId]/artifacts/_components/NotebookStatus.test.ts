import { describe, expect, it } from "vitest";

import {
  notebookInProgress,
  notebookStatusPresentation,
} from "./NotebookStatus";

const state = {
  error: null,
  finishedAt: null,
  sectionCount: null,
  pageCount: null,
  emptySectionCount: null,
  unreadableSectionCount: null,
};

describe("notebookStatusPresentation", () => {
  it("marks queued and running preparation as busy", () => {
    expect(
      notebookStatusPresentation({ ...state, status: "queued" }),
    ).toMatchObject({
      label: "Waiting to prepare",
      busy: true,
    });
    expect(
      notebookStatusPresentation({ ...state, status: "running" }),
    ).toMatchObject({
      label: "Preparing",
      busy: true,
    });
  });

  it("summarizes a ready notebook, including empty and unreadable sections", () => {
    expect(
      notebookStatusPresentation({
        ...state,
        status: "ready",
        sectionCount: 3,
        pageCount: 1,
        emptySectionCount: 1,
        unreadableSectionCount: 1,
      }).detail,
    ).toBe("1 page · 3 sections · 1 empty · 1 unreadable");
  });

  it("explains a failure with the fixed message for its code", () => {
    expect(
      notebookStatusPresentation({
        ...state,
        status: "failed",
        error: "parse_timeout",
      }),
    ).toMatchObject({
      label: "Preparation failed",
      detail: "Reading the notebook took longer than the time limit.",
    });
  });
});

describe("notebookInProgress", () => {
  it("polls only while preparation is queued or running", () => {
    expect(notebookInProgress(null)).toBe(false);
    expect(notebookInProgress({ ...state, status: "unprepared" })).toBe(false);
    expect(notebookInProgress({ ...state, status: "queued" })).toBe(true);
    expect(notebookInProgress({ ...state, status: "running" })).toBe(true);
    expect(notebookInProgress({ ...state, status: "ready" })).toBe(false);
  });
});
