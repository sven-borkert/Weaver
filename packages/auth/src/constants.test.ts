import { describe, expect, it } from "vitest";
import { isReservedEmail } from "./constants";

describe("isReservedEmail", () => {
  it.each([
    "a@weaver.invalid",
    "A@WEAVER.INVALID",
    "a@sub.weaver.invalid",
    " a@weaver.invalid ",
    "a@weaver.invalid.",
    "wiki-agent+x@weaver.invalid",
  ])("reserves %s", (email) => expect(isReservedEmail(email)).toBe(true));

  it.each([
    "a@weaver.local",
    "a@notweaver.invalid",
    "a@weaver.invalid.example",
    "weaver.invalid@example.test",
  ])("leaves %s alone", (email) => expect(isReservedEmail(email)).toBe(false));
});
