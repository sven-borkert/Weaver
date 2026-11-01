import { describe, expect, it } from "vitest";
import { callbackNotice } from "./callbackNotice";

describe("callbackNotice", () => {
  it("maps the callback query to a toast", () => {
    expect(
      callbackNotice({ connected: "6f1f39d4-3f6a-4b7e-9a80-0a4c3a3f1b2c" }),
    ).toEqual({
      kind: "success",
      message:
        "Connected. You can now send documents and tables to this instance.",
    });
    expect(callbackNotice({ error: "denied" })).toEqual({
      kind: "error",
      message: "You declined the connection on the other instance.",
    });
    expect(callbackNotice({ error: "state" })).toEqual({
      kind: "error",
      message:
        "The connection attempt expired or was started by another account. Connect again.",
    });
    expect(callbackNotice({ error: "token" })).toEqual({
      kind: "error",
      message:
        "The other instance refused the connection. Ask its administrator whether this instance is registered there.",
    });
    expect(callbackNotice({ error: "unknown" })?.kind).toBe("error");
    expect(callbackNotice({})).toBeNull();
  });
});
