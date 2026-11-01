import { describe, expect, it, vi } from "vitest";
import { createWeaverAuth } from "./index";

describe("request-scoped OIDC", () => {
  it("keeps session reads independent of provider availability", async () => {
    const oidcResolver = vi.fn(async () => {
      throw new Error("Provider unavailable");
    });
    const auth = createWeaverAuth({
      db: {},
      secret: "x".repeat(32),
      baseURL: "https://weaver.example.test",
      oidcResolver,
    });
    await expect(
      auth.api.getSession({ headers: new Headers() }),
    ).resolves.toBeNull();
    expect(oidcResolver).not.toHaveBeenCalled();
  });
  it("does not initialize discovery or expose raw resolver failures", async () => {
    const onInitializationError = vi.fn();
    const auth = createWeaverAuth({
      db: {},
      secret: "x".repeat(32),
      baseURL: "https://weaver.example.test",
      oidcResolver: async () => {
        throw new Error("PRIVATE PROVIDER DETAIL");
      },
      onInitializationError,
    });
    await expect(
      auth.api.signInSocial({
        body: { provider: "oidc", callbackURL: "https://weaver.example.test/" },
      }),
    ).rejects.toMatchObject({ status: "NOT_FOUND" });
    expect(onInitializationError).toHaveBeenCalled();
  });
  it("rejects ambiguous static and dynamic provider configuration", () => {
    expect(() =>
      createWeaverAuth({
        db: {},
        secret: "x".repeat(32),
        oidc: {
          discoveryUrl: "https://idp.example.test/discovery",
          clientId: "id",
          clientSecret: "secret",
          displayName: "SSO",
        },
        oidcResolver: async () => null,
      }),
    ).toThrow("either");
  });
});
