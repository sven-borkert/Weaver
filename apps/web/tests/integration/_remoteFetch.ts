import { testAuth } from "./_harness";

/** Routes "remote" HTTP calls to this same test instance: Better Auth for OAuth, the transfer route handlers otherwise. */
export function testRemoteFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/"))
      return testAuth().handler(request);
    if (url.pathname === "/api/health")
      return Response.json({ status: "ok", version: "test" });
    const params = {
      params: Promise.resolve({ projectId: url.pathname.split("/").pop()! }),
    };
    switch (true) {
      case url.pathname === "/api/transfer/whoami":
        return (await import("~/app/api/transfer/whoami/route")).GET(request);
      case url.pathname === "/api/transfer/targets":
        return (await import("~/app/api/transfer/targets/route")).GET(request);
      case url.pathname.startsWith("/api/transfer/targets/"):
        return (
          await import("~/app/api/transfer/targets/[projectId]/route")
        ).GET(request, params);
      case url.pathname === "/api/transfer/documents":
        return (await import("~/app/api/transfer/documents/route")).POST(
          request,
        );
      case url.pathname === "/api/transfer/tables":
        return (await import("~/app/api/transfer/tables/route")).POST(request);
    }
    throw new Error(
      `unexpected remote request ${request.method} ${request.url}`,
    );
  }) as typeof fetch;
}
