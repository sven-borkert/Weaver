export const DPOP_ALGS = "EdDSA ES256 ES512 PS256 RS256";

export function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-weaver-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Pre-protocol rejections use a JSON-RPC error body with no id (spec transport §2.1). */
export function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers },
  );
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function bearerChallenge(
  params: Record<string, string | undefined>,
): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${quote(value)}`);
  return `Bearer ${parts.join(", ")}`;
}

/** RFC 9449 §7.1 challenge for a sender-constraint failure. */
export function dpopChallenge(metadataUrl: string, error: string): string {
  return `DPoP algs=${quote(DPOP_ALGS)}, error=${quote(error)}, resource_metadata=${quote(metadataUrl)}`;
}

/** RFC 6750 §3 response: the challenge header plus an OAuth error body. */
export function oauthError(
  status: number,
  challenge: string,
  error: string | null,
  description: string,
): Response {
  return Response.json(
    { ...(error ? { error } : {}), error_description: description },
    { status, headers: { "www-authenticate": challenge } },
  );
}
