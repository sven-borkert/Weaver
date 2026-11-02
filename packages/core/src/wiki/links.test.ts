import { expect, it } from "vitest";
import { trackedLink } from "./links";

const id = "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c";
it("builds a paste-ready tracked link and escapes label brackets", () => {
  expect(trackedLink("document", id, "Plain")).toBe(
    `[Plain](weaver://document/${id})`,
  );
  expect(trackedLink("table", id, "a [b]\\c\nd")).toBe(
    `[a \\[b\\]\\\\c d](weaver://table/${id})`,
  );
  expect(trackedLink("document", id, "  ")).toBe(
    `[Untitled](weaver://document/${id})`,
  );
});
