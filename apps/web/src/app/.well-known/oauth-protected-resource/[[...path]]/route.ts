import { auth } from "~/server/auth";

// RFC 9728: the MCP plugin serves this document from its onRequest hook when
// the raw request path is /.well-known/oauth-protected-resource[/api/mcp]; the
// request must therefore be forwarded unchanged rather than re-mounted under /api/auth.
export function GET(request: Request) {
  return auth.handler(request);
}

export const HEAD = GET;
