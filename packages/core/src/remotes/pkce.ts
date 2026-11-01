import { createHash, randomBytes } from "node:crypto";

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function randomState(): string {
  return randomBytes(32).toString("base64url");
}
