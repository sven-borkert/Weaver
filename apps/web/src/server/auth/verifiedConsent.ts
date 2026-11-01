import { constantTimeEqual, makeSignature } from "better-auth/crypto";
import type { SearchParams } from "~/app/(auth)/consent/mustChangePasswordGate";

// Mirrors the installed OAuth provider's signed-query canonicalization.
export async function verifiedConsentParams(
  params: SearchParams,
  secret: string,
): Promise<URLSearchParams | null> {
  const entries = Object.entries(params).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(
      (item) => [key, item] as [string, string],
    ),
  );
  const query = new URLSearchParams(entries);
  const signatures = query.getAll("sig");
  if (signatures.length !== 1 || !signatures[0]) return null;
  const expires = Number(query.get("exp"));
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return null;
  query.delete("sig");
  const canonical = new URLSearchParams(
    [...query.entries()].sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    ),
  );
  if (
    !constantTimeEqual(
      signatures[0],
      await makeSignature(canonical.toString(), secret),
    )
  )
    return null;
  for (const key of ["client_id", "redirect_uri", "scope", "resource"]) {
    if (query.getAll(key).length !== 1) return null;
  }
  return query;
}
