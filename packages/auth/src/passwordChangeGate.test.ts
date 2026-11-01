import { describe, expect, it } from "vitest";

import {
  isAllowedWhilePasswordChangeRequired,
  isPasswordChangeRequired,
  PASSWORD_CHANGE_ALLOWED_PATHS,
} from "./passwordChangeGate";

describe("isAllowedWhilePasswordChangeRequired", () => {
  it("allows exactly the routes a flagged user needs: sign in, be recognised, sign out, change the password, and start an authorization the consent page will deny", () => {
    expect([...PASSWORD_CHANGE_ALLOWED_PATHS].sort()).toEqual([
      "/change-password",
      "/get-session",
      "/oauth2/authorize",
      "/sign-in/email",
      "/sign-out",
    ]);
    for (const path of PASSWORD_CHANGE_ALLOWED_PATHS) {
      expect(isAllowedWhilePasswordChangeRequired(path, undefined)).toBe(true);
    }
  });

  it("allows an OAuth consent denial but never an acceptance", () => {
    expect(
      isAllowedWhilePasswordChangeRequired("/oauth2/consent", {
        accept: false,
      }),
    ).toBe(true);
    // A missing `accept` is a denial to the provider (`accept === true` is the only grant).
    expect(isAllowedWhilePasswordChangeRequired("/oauth2/consent", {})).toBe(
      true,
    );
    expect(
      isAllowedWhilePasswordChangeRequired("/oauth2/consent", { accept: true }),
    ).toBe(false);
  });

  it("blocks every other route, including near-misses", () => {
    for (const path of [
      "/list-sessions",
      "/update-user",
      "/revoke-sessions",
      "/oauth2/token",
      "/oauth2/continue",
      "/oauth2/userinfo",
      "/jwks",
      "/sign-in/social",
      "/get-session/",
      "/oauth2/authorize/",
    ]) {
      expect(isAllowedWhilePasswordChangeRequired(path, undefined)).toBe(false);
    }
  });
});

describe("isPasswordChangeRequired", () => {
  it("reads only a strict boolean true", () => {
    expect(isPasswordChangeRequired({ mustChangePassword: true })).toBe(true);
    expect(isPasswordChangeRequired({ mustChangePassword: false })).toBe(false);
    expect(isPasswordChangeRequired({ mustChangePassword: "true" })).toBe(
      false,
    );
    expect(isPasswordChangeRequired({})).toBe(false);
    expect(isPasswordChangeRequired(undefined)).toBe(false);
  });
});
