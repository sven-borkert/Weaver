import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth, getSessionUser, MCP_RESOURCE_URL } from "~/server/auth";
import { env } from "~/env";
import { verifiedConsentParams } from "~/server/auth/verifiedConsent";
import { ConsentForm } from "./ConsentForm";
import {
  buildQueryString,
  denyFlaggedConsent,
  type SearchParams,
} from "./mustChangePasswordGate";
import { parseRequestedScopes } from "./scopeDescriptions";

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const requestHeaders = await headers();
  const user = await getSessionUser(requestHeaders);
  if (!user) {
    // Preserve the signed authorization query so consent can resume after login.
    const query = buildQueryString(params);
    redirect(`/login?callbackUrl=${encodeURIComponent(`/consent?${query}`)}`);
  }

  if (user.mustChangePassword) {
    // A flagged user must never see an approvable consent form. Abort the
    // in-flight authorization first (mirrors the page's own "Deny" button)
    // so a waiting client gets a proper error instead of hanging.
    redirect(await denyFlaggedConsent(auth, params, requestHeaders));
  }

  const verified = await verifiedConsentParams(params, env.AUTH_SECRET);
  const clientId = verified?.get("client_id");
  const redirectUri = verified?.get("redirect_uri");
  const scopes = parseRequestedScopes(verified?.get("scope") ?? undefined);
  if (
    !clientId ||
    scopes.length === 0 ||
    verified?.get("resource") !== MCP_RESOURCE_URL
  ) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4 sm:p-8">
        <p className="bg-surface/95 border-line text-text-2 rounded-2xl border p-6 text-[13px] shadow-(--sh-lg)">
          This authorization request is invalid or expired.
        </p>
      </main>
    );
  }

  let clientName = clientId;
  try {
    const client = await auth.api.getOAuthClientPublic({
      query: { client_id: clientId },
      headers: requestHeaders,
    });
    if (client?.client_name) clientName = client.client_name;
  } catch {
    // Unknown or unreadable client metadata: fall back to the raw client id.
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-8">
      <ConsentForm
        clientId={clientId}
        clientName={clientName}
        redirectUri={redirectUri ?? null}
        resource={MCP_RESOURCE_URL}
        scopes={scopes}
        userEmail={user.email}
      />
    </main>
  );
}
