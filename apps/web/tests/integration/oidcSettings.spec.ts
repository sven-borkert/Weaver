import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { parseEncryptionKeyRing } from "@weaver/config/encryptionKeys";
import { resolveOidcRuntime } from "@weaver/core/services/oidc/runtime";
import {
  assertOidcSecretsDecryptable,
  rotateOidcSecrets,
} from "@weaver/core/services/oidc/credentials";
import { updateOidcSettings } from "@weaver/core/services/oidcSettings";
import {
  callerFor,
  getPrisma,
  makeUser,
  resetDb,
  securityContextFor,
  testEncryptionKeys,
} from "./_harness";

const origin = "https://idp.example.test";
const secret = "oidc-client-secret-only-for-test";
const publicKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).publicKey.export({ format: "jwk" });
function fixture(issuer = origin) {
  return vi.fn<typeof fetch>(async (url) =>
    Response.json(
      (url instanceof Request ? url.url : url.toString()).endsWith("/jwks")
        ? {
            keys: [{ ...publicKey, alg: "RS256", use: "sig" }],
          }
        : {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
          },
    ),
  );
}
const input = {
  expectedRevision: null,
  enabled: true,
  displayName: "Authentik",
  discoveryUrl: `${origin}/discovery`,
  clientId: "weaver",
  clientSecret: secret,
};
function dependencies(fetchImpl = fixture()) {
  return {
    ring: testEncryptionKeys(),
    fetchImpl,
    callbackUrl: "https://weaver.example.test/weaver/api/auth/callback/oidc",
  };
}
beforeEach(resetDb);

describe("OIDC administration settings", () => {
  it("encrypts the secret and never returns it through admin reads", async () => {
    const user = await makeUser("Admin", "oidc-settings");
    const deps = dependencies();
    const admin = callerFor(user, { oidcFetch: deps.fetchImpl });
    const saved = await admin.oidc.updateSettings(input);
    expect(saved).toMatchObject({
      enabled: true,
      source: "database",
      hasClientSecret: true,
    });
    expect(JSON.stringify(await admin.oidc.getSettings())).not.toContain(
      secret,
    );
    expect(
      JSON.stringify(
        await getPrisma().systemSetting.findUnique({
          where: { key: "auth.oidc" },
        }),
      ),
    ).not.toContain(secret);
    expect(await resolveOidcRuntime(getPrisma(), deps)).toMatchObject({
      clientSecret: secret,
    });
  });
  it("denies non-admin read, test and save before making provider requests", async () => {
    const user = await makeUser("User", "oidc-denied");
    const fetchImpl = fixture();
    const caller = callerFor(user, { oidcFetch: fetchImpl });
    await expect(caller.oidc.getSettings()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.oidc.testConnection({ discoveryUrl: input.discoveryUrl }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.oidc.updateSettings(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("tests unsaved discovery without persisting or accepting a secret", async () => {
    const user = await makeUser("Admin", "oidc-test");
    const caller = callerFor(user, { oidcFetch: fixture() });
    expect(
      await caller.oidc.testConnection({ discoveryUrl: input.discoveryUrl }),
    ).toMatchObject({ compatible: true });
    expect(
      await getPrisma().systemSetting.findUnique({
        where: { key: "auth.oidc" },
      }),
    ).toBeNull();
    await expect(
      caller.oidc.testConnection({
        discoveryUrl: input.discoveryUrl,
        clientSecret: secret,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("takes ownership of environment settings retaining their secret and disables the fallback", async () => {
    const user = await makeUser("Admin", "oidc-fallback");
    const fallback = { ...input, clientSecret: secret };
    const deps = { ...dependencies(), fallback };
    const caller = callerFor(user, {
      oidcFetch: deps.fetchImpl,
      oidcFallback: fallback,
    });
    expect(await caller.oidc.getSettings()).toMatchObject({
      source: "environment",
      hasClientSecret: true,
    });
    const saved = await caller.oidc.updateSettings({
      ...input,
      clientSecret: "",
    });
    const active = await resolveOidcRuntime(getPrisma(), deps);
    expect(active?.clientSecret).toBe(secret);
    await caller.oidc.updateSettings({
      ...input,
      expectedRevision: saved.revision,
      enabled: false,
      clientSecret: "",
    });
    expect(await resolveOidcRuntime(getPrisma(), { ...deps })).toBeNull();
  });
  it("retains generation on label edits, changes it on replacement, and rejects stale writes", async () => {
    const user = await makeUser("Admin", "oidc-revision");
    const deps = dependencies();
    const actor = securityContextFor(user);
    const saved = await updateOidcSettings(getPrisma(), actor, input, deps);
    const before = await resolveOidcRuntime(getPrisma(), deps);
    const renamed = await updateOidcSettings(
      getPrisma(),
      actor,
      {
        ...input,
        expectedRevision: saved.revision,
        displayName: "Company",
        clientSecret: "",
      },
      deps,
    );
    expect((await resolveOidcRuntime(getPrisma(), deps))?.generation).toBe(
      before?.generation,
    );
    await expect(
      updateOidcSettings(
        getPrisma(),
        actor,
        { ...input, expectedRevision: saved.revision },
        deps,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await updateOidcSettings(
      getPrisma(),
      actor,
      {
        ...input,
        expectedRevision: renamed.revision,
        clientSecret: "replacement",
      },
      deps,
    );
    expect((await resolveOidcRuntime(getPrisma(), deps))?.generation).not.toBe(
      before?.generation,
    );
  });
  it("saves an empty disabled row without a key ring or provider request", async () => {
    const user = await makeUser("Admin", "oidc-empty");
    const deps = { ...dependencies(), ring: null };
    const saved = await updateOidcSettings(
      getPrisma(),
      securityContextFor(user),
      {
        ...input,
        enabled: false,
        discoveryUrl: "",
        clientId: "",
        clientSecret: "",
      },
      deps,
    );
    expect(saved.hasClientSecret).toBe(false);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    await expect(
      updateOidcSettings(
        getPrisma(),
        securityContextFor(user),
        { ...input, expectedRevision: saved.revision },
        deps,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("failed activation preserves the last saved settings", async () => {
    const user = await makeUser("Admin", "oidc-failure");
    const actor = securityContextFor(user);
    const deps = dependencies();
    const saved = await updateOidcSettings(getPrisma(), actor, input, deps);
    await expect(
      updateOidcSettings(
        getPrisma(),
        actor,
        { ...input, expectedRevision: saved.revision },
        {
          ...deps,
          fetchImpl: async () =>
            new Response("PRIVATE REMOTE BODY", { status: 500 }),
        },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await resolveOidcRuntime(getPrisma(), deps))?.clientSecret).toBe(
      secret,
    );
  });
  it("serializes concurrent first saves", async () => {
    const user = await makeUser("Admin", "oidc-race");
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        updateOidcSettings(
          getPrisma(),
          securityContextFor(user),
          input,
          dependencies(),
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });
  it("rejects issuer replacement after an OIDC identity has been linked", async () => {
    const user = await makeUser("Admin", "oidc-issuer");
    const saved = await updateOidcSettings(
      getPrisma(),
      securityContextFor(user),
      input,
      dependencies(),
    );
    await getPrisma().account.create({
      data: {
        id: crypto.randomUUID(),
        userId: user.id,
        providerId: "oidc",
        issuer: origin,
        accountId: "subject",
      },
    });
    await expect(
      updateOidcSettings(
        getPrisma(),
        securityContextFor(user),
        {
          ...input,
          expectedRevision: saved.revision,
          discoveryUrl: "https://other.example.test/discovery",
        },
        dependencies(fixture("https://other.example.test")),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("rotates encryption without changing settings revision or generation", async () => {
    const user = await makeUser("Admin", "oidc-rotate");
    const deps = dependencies();
    const saved = await updateOidcSettings(
      getPrisma(),
      securityContextFor(user),
      input,
      deps,
    );
    const before = await resolveOidcRuntime(getPrisma(), deps);
    const old = deps.ring;
    const newKey = createHash("sha256")
      .update("OIDC test rotation")
      .digest("base64");
    const ring = parseEncryptionKeyRing(
      [...old.keys.entries()]
        .map(([v, k]) => `${v}:${Buffer.from(k).toString("base64")}`)
        .concat(`${old.activeVersion + 1}:${newKey}`)
        .join(","),
    )!;
    expect(await rotateOidcSecrets(getPrisma(), ring)).toEqual({
      rotated: 1,
      skipped: 0,
    });
    expect(
      await resolveOidcRuntime(getPrisma(), { ...deps, ring }),
    ).toMatchObject({ generation: before!.generation, clientSecret: secret });
    expect((await callerFor(user).oidc.getSettings()).revision).toBe(
      saved.revision,
    );
    await expect(
      assertOidcSecretsDecryptable(getPrisma(), old),
    ).rejects.toThrow();
    await assertOidcSecretsDecryptable(getPrisma(), ring);
  });

  it("waits for an uncommitted first OIDC account before deciding issuer replacement", async () => {
    const user = await makeUser("Admin", "oidc-insert-race");
    const deps = dependencies();
    const saved = await updateOidcSettings(
      getPrisma(),
      securityContextFor(user),
      input,
      deps,
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inserting = getPrisma().$transaction(async (tx) => {
      await tx.account.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          providerId: "oidc",
          issuer: origin,
          accountId: "first-subject",
        },
      });
      entered();
      await gate;
    });
    await reached;
    const saving = updateOidcSettings(
      getPrisma(),
      securityContextFor(user),
      {
        ...input,
        expectedRevision: saved.revision,
        discoveryUrl: "https://new.example.test/discovery",
      },
      dependencies(fixture("https://new.example.test")),
    ).then(
      (value) => ({ value }),
      (error) => ({ error: error as { code: string } }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      release();
    }
    await inserting;
    expect(await saving).toMatchObject({
      error: { code: "PRECONDITION_FAILED" },
    });
    expect(
      (await resolveOidcRuntime(getPrisma(), deps))?.discovery.metadata.issuer,
    ).toBe(origin);
  });
});
