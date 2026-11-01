import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";

import { auth } from "~/server/auth";

// RFC 8414: the issuer has a path (/api/auth), so the document lives at
// /.well-known/oauth-authorization-server/api/auth (root also answers).
export const GET = oauthProviderAuthServerMetadata(auth);
