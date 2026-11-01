import type { NextRequest } from "next/server";
import { db } from "@weaver/db";
import { emitDiagnostic } from "@weaver/core/diagnostics/writer";
import { isCoreError } from "@weaver/core/errors";
import { UUID_RE } from "@weaver/core/ingestion/paths";
import { createSessionSecurityContext } from "@weaver/core/security/context";

import { attachmentDisposition } from "~/lib/http/contentDisposition";
import { getSessionUser } from "~/server/auth";
import {
  exportDocumentPdf,
  PdfLimitError,
} from "~/server/documents/pdf/export";
import { PdfBusyError } from "~/server/documents/pdf/limiter";
import {
  PdfTimeoutError,
  PdfUnavailableError,
} from "~/server/documents/pdf/render";
import {
  problem,
  statusForCoreError,
} from "~/server/ingestion/multipartUpload";

export const dynamic = "force-dynamic";

function failed(
  projectId: string,
  documentId: string,
  reason: string,
  error: unknown,
): void {
  emitDiagnostic({
    severity: "warn",
    event: "document.pdf.failed",
    message: "document PDF export failed",
    projectId,
    documentId,
    details: {
      reason,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const user = await getSessionUser(req.headers);
  if (!user) return problem(401, "unauthorized");
  if (user.mustChangePassword) return problem(403, "password change required");
  const { documentId } = await ctx.params;
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!UUID_RE.test(documentId) || !UUID_RE.test(projectId))
    return problem(404, "not found");
  const actor = createSessionSecurityContext({
    userId: user.id,
    globalRole: user.role,
    sessionId: user.sessionId,
  });
  try {
    const { bytes, filename } = await exportDocumentPdf(
      db,
      { projectId, documentId },
      actor,
    );
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
        "content-disposition": attachmentDisposition(filename),
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isCoreError(error))
      return problem(statusForCoreError(error.code), error.message);
    if (error instanceof PdfLimitError) {
      failed(projectId, documentId, "limit", error);
      return problem(413, error.message);
    }
    if (error instanceof PdfBusyError) {
      failed(projectId, documentId, "busy", error);
      return problem(503, error.message, {}, { "retry-after": "5" });
    }
    if (error instanceof PdfUnavailableError) {
      failed(projectId, documentId, "unavailable", error);
      return problem(503, "PDF export is unavailable on this server");
    }
    if (error instanceof PdfTimeoutError) {
      failed(projectId, documentId, "timeout", error);
      return problem(504, "PDF export timed out");
    }
    failed(projectId, documentId, "render", error);
    return problem(500, "PDF export failed");
  }
}
