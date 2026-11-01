import { expect, it } from "vitest";
import { resolveSshTargetAddress } from "./outboundSsh";
const resolve = (address: string) => async () => [
  { address, family: address.includes(":") ? 6 : 4 },
];
it.each([
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.2",
  "192.168.1.2",
  "169.254.169.254",
  "::1",
  "::ffff:127.0.0.1",
  "fc00::1",
])("rejects unapproved private SSH targets: %s", async (address) => {
  await expect(
    resolveSshTargetAddress("git.example", 22, {
      allowedTargets: [],
      resolve: resolve(address),
    }),
  ).rejects.toThrow("SSH target is not allowed");
});
it("names the blocked target and the setting that allows it", async () => {
  await expect(
    resolveSshTargetAddress("git.internal", 2222, {
      allowedTargets: [],
      resolve: resolve("10.1.2.3"),
    }),
  ).rejects.toThrow(
    "git.internal:2222 resolves to the non-public address 10.1.2.3; list it in WEAVER_GIT_ALLOWED_SSH_TARGETS",
  );
});
it("returns the validated public address for SSH pinning", async () => {
  expect(
    await resolveSshTargetAddress("git.example", 22, {
      allowedTargets: [],
      resolve: resolve("93.184.216.34"),
    }),
  ).toBe("93.184.216.34");
});
it("allows only the configured private host and port", async () => {
  const options = {
    allowedTargets: ["git.internal:2222"],
    resolve: resolve("10.1.2.3"),
  };
  expect(await resolveSshTargetAddress("git.internal", 2222, options)).toBe(
    "10.1.2.3",
  );
  await expect(
    resolveSshTargetAddress("git.internal", 22, options),
  ).rejects.toThrow();
  await expect(
    resolveSshTargetAddress("other.internal", 2222, options),
  ).rejects.toThrow();
});
it("rejects mixed public/private answers before SSH can select an unchecked address", async () => {
  await expect(
    resolveSshTargetAddress("git.example", 22, {
      allowedTargets: [],
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    }),
  ).rejects.toThrow();
});
