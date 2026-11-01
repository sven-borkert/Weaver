import { handleProjectApiRequest } from "~/server/projectApi/dispatch";
import { projectApiRoute } from "@weaver/core/projectApi/contracts";
export const runtime = "nodejs";
export async function GET(
  req: Request,
  context: { params: Promise<{ projectId: string; documentId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("document.get"),
  );
}
export async function HEAD(
  req: Request,
  context: { params: Promise<{ projectId: string; documentId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("document.head"),
  );
}
export async function PUT(
  req: Request,
  context: { params: Promise<{ projectId: string; documentId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("document.replace"),
  );
}
export async function DELETE(
  req: Request,
  context: { params: Promise<{ projectId: string; documentId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("document.delete"),
  );
}
