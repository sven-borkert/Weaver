import { describe, expect, it } from "vitest";
import { notebookPageText } from "./notebookText";

const ARTIFACT = "11111111-1111-4111-8111-111111111111";

describe("notebookPageText", () => {
  it("preserves text and table cell boundaries and references images for import", () => {
    expect(
      notebookPageText(
        [
          { kind: "text", text: "Überblick\n日本語" },
          {
            kind: "table",
            rows: [
              ["Host", "Port"],
              ["mail", "443"],
            ],
          },
          { kind: "image", assetId: "a".repeat(64), alt: "Network diagram" },
          { kind: "attachment", name: "runbook.pdf", byteSize: 2048 },
          { kind: "image", assetId: "b".repeat(64), alt: "" },
        ],
        ARTIFACT,
      ),
    ).toBe(
      `Überblick\n日本語\n\nHost\tPort\nmail\t443\n\n![Network diagram](weaver-image:${ARTIFACT}/${"a".repeat(64)})\n\n[Attachment: runbook.pdf (2048 bytes)]\n\n![Image](weaver-image:${ARTIFACT}/${"b".repeat(64)})`,
    );
  });

  it("returns an empty string for a page with no content", () => {
    expect(notebookPageText([], ARTIFACT)).toBe("");
  });
});
