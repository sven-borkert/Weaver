import { describe, expect, it } from "vitest";
import {
  connectionDefaults,
  connectionFormSchema,
  needsTokenReentry,
  tokenPatch,
  updateInput,
  type ConnectionFormValues,
} from "./connectionDraft";

const values: ConnectionFormValues = {
  name: "Example",
  endpoint: "https://example.test/mcp",
  authMode: "bearer",
  token: "replacement",
  timeoutMs: 30_000,
  enabled: true,
  allowInsecureTls: false,
};

describe("connection draft snapshots", () => {
  it("pins the revision captured when editing despite a later refresh", () => {
    const draft = { id: "connection", revision: 4 };
    const refreshed = { id: "connection", revision: 5 };
    expect(updateInput(draft, values).expectedRevision).toBe(4);
    expect(updateInput(draft, values).expectedRevision).not.toBe(
      refreshed.revision,
    );
  });

  it("omits kept and hidden tokens while replacing a bearer token explicitly", () => {
    expect(tokenPatch({ ...values, token: "" })).toEqual({});
    expect(tokenPatch(values)).toEqual({ token: "replacement" });
    expect(tokenPatch({ ...values, authMode: "none" })).toEqual({});
  });

  it("asks for the token again only when a kept bearer token would change origin", () => {
    const saved = { endpoint: values.endpoint, authMode: "bearer" as const };
    const moved = {
      ...values,
      endpoint: "https://other.test/mcp",
      token: "",
    };
    expect(needsTokenReentry(saved, moved)).toBe(true);
    expect(needsTokenReentry(saved, { ...moved, token: "new" })).toBe(false);
    expect(needsTokenReentry(saved, { ...moved, authMode: "none" })).toBe(
      false,
    );
    expect(
      needsTokenReentry(saved, {
        ...moved,
        endpoint: "https://example.test/v2/mcp?tenant=a",
      }),
    ).toBe(false);
    expect(
      needsTokenReentry(saved, {
        ...moved,
        endpoint: "http://example.test/mcp",
      }),
    ).toBe(true);
    expect(needsTokenReentry(saved, { ...moved, endpoint: "not a url" })).toBe(
      false,
    );
    expect(needsTokenReentry({ ...saved, authMode: "none" }, moved)).toBe(
      false,
    );
    expect(needsTokenReentry(undefined, moved)).toBe(false);
  });

  it("validates endpoint constraints", () => {
    expect(
      connectionFormSchema.safeParse({
        ...values,
        endpoint: "ftp://person:secret@example.test/mcp#token",
      }).success,
    ).toBe(false);
  });

  it("seeds every new opening from accepted data without a prior create secret", () => {
    const { token: _secret, ...connection } = values;
    expect(connectionDefaults()).toMatchObject({
      name: "",
      endpoint: "",
      token: "",
      enabled: false,
      allowInsecureTls: false,
    });
    expect(connectionDefaults(connection)).toMatchObject({
      name: "Example",
      token: "",
      allowInsecureTls: false,
    });
    expect(
      connectionDefaults({ ...connection, allowInsecureTls: true }),
    ).toMatchObject({ allowInsecureTls: true });
  });
});
