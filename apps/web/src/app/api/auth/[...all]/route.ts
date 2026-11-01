import { toNextJsHandler } from "better-auth/next-js";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";

import { auth } from "~/server/auth";
import { withAuthRequestBasePath } from "~/server/auth/requestBasePath";

const handlers = toNextJsHandler(auth);

export function GET(request: Request) {
  return handlers.GET(withAuthRequestBasePath(request));
}

export async function POST(request: Request) {
  const response = await handlers.POST(withAuthRequestBasePath(request));
  if (
    new URL(request.url).pathname.endsWith("/sign-in/email") &&
    response.status >= 400
  ) {
    emitDiagnostic({
      event: "auth.signin.failed",
      severity: "warn",
      message: `sign-in failed with ${response.status}`,
      outcome: "denied",
      statusCode: response.status,
    });
  }
  return response;
}
