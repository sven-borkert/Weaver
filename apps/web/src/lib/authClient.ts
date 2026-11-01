"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

import { withBasePath } from "./basePath";

// Browser requests must carry the application base path; the server mounts
// at /api/auth because Next strips the prefix first. The OAuth client plugin
// forwards the signed `oauth_query` from the current page (login/consent) so
// Better Auth can continue an /oauth2/authorize flow after sign-in or consent.
export const authClient = createAuthClient({
  basePath: withBasePath("/api/auth"),
  // Login and consent forms own navigation after their successful responses.
  disableDefaultFetchPlugins: true,
  plugins: [oauthProviderClient()],
});
