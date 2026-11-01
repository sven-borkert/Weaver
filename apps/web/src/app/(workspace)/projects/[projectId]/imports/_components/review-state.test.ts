import { describe, expect, it, vi } from "vitest";
import {
  confidenceLabel,
  resolveFolderValue,
  reviewDestination,
  acceptReviewedDraft,
  linksForDraft,
  rejectDialogState,
  shouldSaveBeforeAccept,
} from "./review-state";

describe("review-state", () => {
  it("labels confidence bands", () => {
    expect(confidenceLabel(1)).toBe("High");
    expect(confidenceLabel(0.8)).toBe("High");
    expect(confidenceLabel(0.6)).toBe("Medium");
    expect(confidenceLabel(0.59)).toBe("Low");
  });

  it("saves a pristine normalized root before accepting, in order", async () => {
    const calls: string[] = [];
    const payload = {
      proposedFolderPath: "",
      links: [{ documentId: "doc", keep: false }],
    };
    await acceptReviewedDraft({
      status: "ready",
      isDirty: false,
      folderWasNormalized: true,
      updatePayload: payload,
      reviewedRevision: 3,
      update: async (received) => {
        expect(received).toEqual(payload);
        calls.push(`update:${received.proposedFolderPath}`);
        return { draft: { revision: 4 } };
      },
      accept: (revision) => calls.push(`accept:${revision}`),
    });
    // The accept names the revision the reviewer's own save produced.
    expect(calls).toEqual(["update:", "accept:4"]);
  });

  it("retries accepting directly without an update", async () => {
    const calls: string[] = [];
    await acceptReviewedDraft({
      status: "accepting",
      isDirty: true,
      folderWasNormalized: true,
      updatePayload: { proposedFolderPath: "" },
      reviewedRevision: 3,
      update: async () => {
        calls.push("update");
        return { draft: null };
      },
      accept: (revision) => calls.push(`accept:${revision}`),
    });
    expect(calls).toEqual(["accept:3"]);
  });

  it("does not accept after a failed draft save", async () => {
    const accept = vi.fn();
    await expect(
      acceptReviewedDraft({
        status: "ready",
        isDirty: true,
        folderWasNormalized: false,
        updatePayload: { proposedFolderPath: "guides" },
        reviewedRevision: 3,
        update: () => Promise.reject(new Error("save failed")),
        accept,
      }),
    ).rejects.toThrow("save failed");
    expect(accept).not.toHaveBeenCalled();
  });

  it("submits edited document links while preserving table suggestions", () => {
    const stored = [{ documentId: "doc", keep: true }];
    const edited = [{ documentId: "doc", keep: false }];
    expect(linksForDraft("document", edited, stored)).toBe(edited);
    expect(linksForDraft("table", edited, stored)).toBe(stored);
  });

  it("disables rejection controls and labels pending rejection", () => {
    expect(rejectDialogState(true)).toEqual({
      disabled: true,
      label: "Rejecting…",
    });
  });

  it("keeps a proposed folder that exists and falls back to the root otherwise", () => {
    expect(resolveFolderValue(["a", "a/b"], "a/b")).toEqual({
      value: ["a", "b"],
      missing: false,
    });
    expect(resolveFolderValue(["a"], "")).toEqual({
      value: [],
      missing: false,
    });
    expect(resolveFolderValue(["a"], "gone")).toEqual({
      value: [],
      missing: true,
    });
  });

  it("routes to the created resource", () => {
    expect(reviewDestination("p", "document", "d")).toBe(
      "/projects/p/documents/d",
    );
    expect(reviewDestination("p", "table", "t")).toBe("/projects/p/tables/t");
  });

  it("saves normalized review metadata before ready acceptance but retries accepting directly", () => {
    expect(shouldSaveBeforeAccept("ready", false, true)).toBe(true);
    expect(shouldSaveBeforeAccept("ready", true, false)).toBe(true);
    expect(shouldSaveBeforeAccept("accepting", true, true)).toBe(false);
  });
});
