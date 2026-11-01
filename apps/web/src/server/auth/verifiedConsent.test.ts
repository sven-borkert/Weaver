import { makeSignature } from "better-auth/crypto";
import { expect, it } from "vitest";
import { verifiedConsentParams } from "./verifiedConsent";

it("displays only unexpired, signed authorization parameters", async () => {
  const secret = "s".repeat(32);
  const fields = {
    client_id: "client",
    exp: String(Math.floor(Date.now() / 1000) + 60),
    redirect_uri: "https://client.example/callback",
    resource: "https://weaver.example/api/mcp",
    scope: "openid",
  };
  const sig = await makeSignature(
    new URLSearchParams(Object.entries(fields).sort()).toString(),
    secret,
  );
  expect(
    (await verifiedConsentParams({ ...fields, sig }, secret))?.get("client_id"),
  ).toBe("client");
  expect(await verifiedConsentParams(fields, secret)).toBeNull();
  expect(
    await verifiedConsentParams(
      { ...fields, sig, client_id: "attacker" },
      secret,
    ),
  ).toBeNull();
  expect(
    await verifiedConsentParams({ ...fields, sig: [sig, sig] }, secret),
  ).toBeNull();
  expect(
    await verifiedConsentParams({ ...fields, sig, exp: "0" }, secret),
  ).toBeNull();
});
