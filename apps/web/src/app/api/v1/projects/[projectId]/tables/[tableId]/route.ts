import { handleProjectApiRequest } from "~/server/projectApi/dispatch";
import { projectApiRoute } from "@weaver/core/projectApi/contracts";
export const runtime = "nodejs";
export async function GET(
  req: Request,
  context: { params: Promise<{ projectId: string; tableId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("table.get"),
  );
}
export async function HEAD(
  req: Request,
  context: { params: Promise<{ projectId: string; tableId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("table.head"),
  );
}
export async function PUT(
  req: Request,
  context: { params: Promise<{ projectId: string; tableId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("table.replace"),
  );
}
export async function DELETE(
  req: Request,
  context: { params: Promise<{ projectId: string; tableId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("table.delete"),
  );
}
