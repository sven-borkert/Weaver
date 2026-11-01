import type { OidcDiscoveryResult } from "@weaver/config/oidc";

export function OidcMetadataPanel({ result }: { result: OidcDiscoveryResult }) {
  const m = result.metadata;
  const rows: Array<[string, string | string[] | undefined]> = [
    ["Issuer", m.issuer],
    ["Authorization endpoint", m.authorization_endpoint],
    ["Token endpoint", m.token_endpoint],
    ["Signing keys (JWKS)", m.jwks_uri],
    ["User info endpoint", m.userinfo_endpoint],
    ["Scopes", m.scopes_supported],
    ["ID-token signing algorithms", m.id_token_signing_alg_values_supported],
    ["PKCE methods", m.code_challenge_methods_supported],
    ["Client authentication methods", m.token_endpoint_auth_methods_supported],
    [
      "Client authentication used",
      result.tokenEndpointAuthMethod ?? "Unsupported",
    ],
  ];
  return (
    <section
      aria-label="OIDC metadata"
      className="border-line bg-surface flex min-w-0 flex-col gap-3 rounded-lg border p-4"
    >
      <h3 className="text-text m-0 text-sm font-semibold">Provider metadata</h3>
      <p role="status" className="text-text-2 m-0 text-[13px]">
        {result.compatible
          ? "Discovery succeeded. The provider advertises compatible metadata."
          : "The provider metadata is incompatible with OIDC sign-in."}
      </p>
      {result.issues.map((issue) => (
        <p role="alert" key={issue} className="text-danger m-0 text-[13px]">
          {issue}
        </p>
      ))}
      <dl className="m-0 grid min-w-0 grid-cols-1 gap-x-5 gap-y-2 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-text-3">{label}</dt>
            <dd className="text-text m-0 min-w-0 wrap-anywhere">
              {Array.isArray(value)
                ? value.join(", ") || "None advertised"
                : (value ?? "Not advertised")}
            </dd>
          </div>
        ))}
      </dl>
      {result.warnings.length ? (
        <ul className="text-text-3 m-0 list-disc space-y-1 pl-4 text-[12px]">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
