import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MACHINE_UUID_RE, PROJECT_API_PREFIX } from "./constants";

export function generateProjectMachineToken(keyId: string) {
  if (!MACHINE_UUID_RE.test(keyId))
    throw new Error("Invalid project key identity");
  const secret = `${PROJECT_API_PREFIX}${keyId}.${randomBytes(32).toString("base64url")}`;
  const digest = createHash("sha256").update(secret).digest("hex");
  return { secret, digest, fingerprint: digest.slice(0, 12) };
}

export function verifyProjectMachineDigest(
  secret: string,
  digest: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    Buffer.from(digest, "hex"),
  );
}

export function parseProjectMachineBearer(
  authorization: string | null,
): { token: string; keyId: string } | null {
  if (!authorization || authorization.length > 200) return null;
  const header = /^Bearer (\S+)$/i.exec(authorization);
  const token = header?.[1];
  if (!token?.startsWith(PROJECT_API_PREFIX)) return null;
  const [keyId, secret, extra] = token
    .slice(PROJECT_API_PREFIX.length)
    .split(".");
  if (
    !keyId ||
    !MACHINE_UUID_RE.test(keyId) ||
    !secret ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
    extra !== undefined
  )
    return null;
  return { token, keyId };
}
