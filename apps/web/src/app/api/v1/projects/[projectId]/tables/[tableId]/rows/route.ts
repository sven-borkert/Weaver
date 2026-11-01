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
    projectApiRoute("table.rows"),
  );
}
export async function POST(
  req: Request,
  context: { params: Promise<{ projectId: string; tableId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("rows.append"),
  );
}
export async function PATCH(
  req: Request,
  context: { params: Promise<{ projectId: string; tableId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("rows.update"),
  );
}
