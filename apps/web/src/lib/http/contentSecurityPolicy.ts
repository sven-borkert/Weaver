export function contentSecurityPolicy(
  nonce: string,
  reportUrl: string,
  development: boolean,
) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    `report-uri ${reportUrl}`,
    "report-to csp",
  ].join("; ");
}
