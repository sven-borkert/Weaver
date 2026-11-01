import { describe, expect, it } from "vitest";

import { shouldRedirectToChangePassword } from "./passwordChangeGate";

describe("shouldRedirectToChangePassword", () => {
  it("never redirects when the flag is not set", () => {
    expect(shouldRedirectToChangePassword(false, "/")).toBe(false);
    expect(shouldRedirectToChangePassword(false, "/account/password")).toBe(
      false,
    );
    expect(shouldRedirectToChangePassword(false, null)).toBe(false);
  });

  it("redirects away from ordinary workspace routes while flagged", () => {
    expect(shouldRedirectToChangePassword(true, "/")).toBe(true);
    expect(shouldRedirectToChangePassword(true, "/projects/abc")).toBe(true);
    expect(shouldRedirectToChangePassword(true, "/admin/users")).toBe(true);
  });

  it("is exempt on its own page — the loop-prevention case", () => {
    expect(shouldRedirectToChangePassword(true, "/account/password")).toBe(
      false,
    );
  });

  it("stays exempt on its own page with a query string or hash", () => {
    expect(shouldRedirectToChangePassword(true, "/account/password?x=1")).toBe(
      false,
    );
    expect(
      shouldRedirectToChangePassword(true, "/account/password#section"),
    ).toBe(false);
  });

  it("does not exempt a route that merely starts with the password path", () => {
    expect(
      shouldRedirectToChangePassword(true, "/account/password-recovery"),
    ).toBe(true);
  });

  it("strips a configured base path before comparing — the base-path-mismatch case", () => {
    expect(
      shouldRedirectToChangePassword(
        true,
        "/knowledge/account/password",
        "/knowledge",
      ),
    ).toBe(false);
    expect(
      shouldRedirectToChangePassword(
        true,
        "/knowledge/account/password?x=1",
        "/knowledge",
      ),
    ).toBe(false);
    expect(
      shouldRedirectToChangePassword(
        true,
        "/knowledge/projects/abc",
        "/knowledge",
      ),
    ).toBe(true);
  });

  it("fails toward NOT redirecting when the request path is unknown", () => {
    expect(shouldRedirectToChangePassword(true, null)).toBe(false);
    expect(shouldRedirectToChangePassword(true, undefined)).toBe(false);
    expect(shouldRedirectToChangePassword(true, "")).toBe(false);
  });
});
