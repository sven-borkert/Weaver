import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "~/lib/http/contentSecurityPolicy";
import { withBasePath } from "~/lib/basePath";

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(
    "x-weaver-request-path",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const reportUrl = withBasePath("/api/csp-report");
  const policy = contentSecurityPolicy(
    nonce,
    reportUrl,
    process.env.NODE_ENV !== "production",
  );
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set(
    "Reporting-Endpoints",
    `csp="${new URL(reportUrl, request.url).href}"`,
  );
  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|favicon.svg|login-background.webp).*)",
  ],
};
