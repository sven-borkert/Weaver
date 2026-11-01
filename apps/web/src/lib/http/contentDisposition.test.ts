import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./contentDisposition";

describe("attachmentDisposition", () => {
  it("keeps a plain ASCII name", () => {
    expect(attachmentDisposition("report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("gives non-Latin-1 names an ASCII fallback and an RFC 5987 form", () => {
    expect(attachmentDisposition('Übersicht "Q3" 📊.xlsx')).toBe(
      `attachment; filename="_bersicht _Q3_ _.xlsx"; filename*=UTF-8''%C3%9Cbersicht%20%22Q3%22%20%F0%9F%93%8A.xlsx`,
    );
  });
});
