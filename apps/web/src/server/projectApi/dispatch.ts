import { randomUUID } from "node:crypto";
import { db } from "@weaver/db";
import { CoreError } from "@weaver/core/errors";
import { resolveProjectMachineContext } from "@weaver/core/security/projectMachine";
import { admitProjectMachineRequest } from "@weaver/core/projectApi/rateLimit";
import { recordProjectApiAudit } from "@weaver/core/projectApi/audit";
import { captureError, emitDiagnostic } from "@weaver/core/diagnostics/writer";
import type { ProjectMachineContext } from "@weaver/core/projectApi/types";
import {
  machineUuid,
  machineCommandSchema,
} from "@weaver/core/projectApi/schemas";
import type {
  ProjectApiRouteParams,
  ProjectApiRouteContract,
} from "@weaver/core/projectApi/contracts";
import {
  queryProjectMachineContent,
  type MachineQuery,
} from "@weaver/core/projectApi/queries";
import { publishProjectMachineContent } from "@weaver/core/services/projectApi";
import {
  assertEmptyProjectApiBody,
  checkProjectApiDeclaredSize,
  readProjectApiJson,
} from "./body";
import { projectApiErrorResponse, projectApiHeaders } from "./respond";

export async function handleProjectApiRequest(
  req: Request,
  params: ProjectApiRouteParams,
  route: ProjectApiRouteContract,
): Promise<Response> {
  const supplied = req.headers.get("x-request-id");
  const requestId =
    supplied && /^[A-Za-z0-9_.:-]{1,64}$/.test(supplied)
      ? supplied
      : randomUUID();
  const started = Date.now();
  let authenticated: ProjectMachineContext | undefined;
  let status = 500;
  let commitSha: string | null = null;
  let resourceId = params.documentId ?? params.tableId ?? null;
  try {
    checkProjectApiDeclaredSize(req);
    for (const value of Object.values(params))
      if (!machineUuid.safeParse(value).success)
        throw new CoreError("BAD_REQUEST");
    const context = await resolveProjectMachineContext(
      db,
      req.headers.get("authorization"),
      params.projectId,
    );
    authenticated = context;
    await admitProjectMachineRequest(db, context);
    const url = new URL(req.url);
    if (
      [...url.searchParams.keys()].some(
        (k) =>
          !route.paginated ||
          !["limit", "cursor"].includes(k) ||
          url.searchParams.getAll(k).length !== 1,
      )
    )
      throw new CoreError("BAD_REQUEST");
    let result: { revision?: string; [key: string]: unknown };
    if (route.mutation) {
      let body: unknown = {};
      if (route.request) {
        const parsed = route.request.safeParse(await readProjectApiJson(req));
        if (!parsed.success) throw new CoreError("BAD_REQUEST");
        body = parsed.data;
      } else await assertEmptyProjectApiBody(req);
      const command = machineCommandSchema.safeParse({
        ...(body as object),
        kind: route.operation,
        ...(params.documentId || params.tableId
          ? { id: params.documentId ?? params.tableId }
          : {}),
        ...(params.rowId ? { rowId: params.rowId } : {}),
      });
      if (!command.success) throw new CoreError("BAD_REQUEST");
      result = await publishProjectMachineContent(db, context, command.data, {
        requestId,
        method: route.method as "POST" | "PUT" | "PATCH" | "DELETE",
        idempotencyKey: req.headers.get("idempotency-key") ?? "",
        ifMatch: req.headers.get("if-match"),
        signal: req.signal,
      });
    } else {
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 50 : Number(limitText);
      if (
        limitText !== null &&
        (!/^\d+$/.test(limitText) ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100)
      )
        throw new CoreError("BAD_REQUEST");
      const query = {
        kind: route.operation,
        ...(params.documentId || params.tableId
          ? { id: params.documentId ?? params.tableId }
          : {}),
        ...(route.paginated
          ? {
              limit,
              ...(url.searchParams.has("cursor")
                ? { cursor: url.searchParams.get("cursor")! }
                : {}),
            }
          : {}),
      } as MachineQuery;
      result = await queryProjectMachineContent(db, context, query);
    }
    const headers = projectApiHeaders(requestId, result.revision);
    status = route.status;
    commitSha = route.mutation ? (result.revision ?? null) : null;
    if (typeof result.resourceId === "string") resourceId = result.resourceId;
    if (route.method === "HEAD")
      return new Response(null, { status: route.status, headers });
    return Response.json(route.response?.parse(result) ?? result, {
      status: route.status,
      headers,
    });
  } catch (error) {
    const response = projectApiErrorResponse(error, requestId);
    status = response.status;
    const details = error instanceof CoreError ? error.details : undefined;
    if (details?.reason === "RECEIPT_PENDING") {
      resourceId =
        typeof details.resourceId === "string" ? details.resourceId : null;
      commitSha =
        typeof details.commitSha === "string" ? details.commitSha : null;
    }
    if (authenticated && response.status >= 500)
      // Closed metadata only: provider errors can echo request content.
      emitDiagnostic({
        event: "runtime.error",
        severity: "error",
        message: "Project API request failed",
        requestId,
        projectId: authenticated.projectId,
        statusCode: response.status,
        outcome: "error",
        details: {
          operation: route.operation,
          errorClass: error instanceof Error ? error.name : typeof error,
          reason: typeof details?.reason === "string" ? details.reason : null,
          operationId:
            typeof details?.operationId === "string"
              ? details.operationId
              : null,
        },
      });
    if (!authenticated)
      // An unverified token's key UUID is never recorded as an identity.
      emitDiagnostic({
        event: "project_api.request.rejected",
        severity: "warn",
        message: "Project API request rejected before authentication",
        requestId,
        statusCode: response.status,
        outcome: "error",
        details: {
          operation: route.operation,
          code:
            error instanceof CoreError ? error.code : "INTERNAL_SERVER_ERROR",
        },
      });
    return req.method === "HEAD"
      ? new Response(null, {
          status: response.status,
          headers: response.headers,
        })
      : response;
  } finally {
    if (authenticated)
      await recordProjectApiAudit(db, {
        requestId,
        keyId: authenticated.keyId,
        projectId: authenticated.projectId,
        method: route.method,
        operation: route.operation,
        resourceId,
        outcome:
          status < 400 ? "succeeded" : status < 500 ? "rejected" : "failed",
        status,
        durationMs: Math.min(2_147_483_647, Math.max(0, Date.now() - started)),
        commitSha,
      }).catch((error: unknown) =>
        captureError({
          event: "project_api.audit.failed",
          severity: "warn",
          message: "Could not record a project API audit event",
          requestId,
          error,
          details: { operation: route.operation, status },
        }),
      );
  }
}
