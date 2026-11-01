import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { isCoreError } from "@weaver/core/errors";
import { completeRemoteConnection } from "@weaver/core/services/remoteInstances";
import type { RemoteRuntimeDeps } from "@weaver/core/services/remoteInstances/types";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { getSessionUser } from "~/server/auth";
import { problem } from "~/server/ingestion/multipartUpload";
import { remoteRuntimeFromEnv } from "~/server/remoteInstances";

export const dynamic = "force-dynamic";

function back(deps: RemoteRuntimeDeps, query: string): Response {
  return Response.redirect(
    `${deps.selfBaseUrl}/account/remote-instances?${query}`,
    303,
  );
}

export async function handleRemoteCallback(
  req: Request,
  deps: RemoteRuntimeDeps,
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  const params = new URL(req.url).searchParams;
  const state = params.get("state") ?? "";
  if (params.get("error")) return back(deps, `error=denied`);
  const code = params.get("code");
  if (!state || !code) return back(deps, `error=state`);
  try {
    const { remoteInstanceId } = await completeRemoteConnection(deps, {
      userId: user.id,
      state,
      code,
    });
    return back(deps, `connected=${remoteInstanceId}`);
  } catch (error) {
    emitDiagnostic({
      severity: "warn",
      event: "remote.transfer.failed",
      message: "remote connection failed",
      userId: user.id,
      details: {
        stage: "callback",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    if (isCoreError(error) && error.details?.field === "state")
      return back(deps, `error=state`);
    if (isCoreError(error) && error.details?.field === "code")
      return back(deps, `error=token`);
    return back(deps, `error=unknown`);
  }
}

export function GET(req: NextRequest): Promise<Response> {
  return handleRemoteCallback(req, remoteRuntimeFromEnv(db));
}
