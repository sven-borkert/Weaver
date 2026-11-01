import { handleProjectApiRequest } from "~/server/projectApi/dispatch";
import { projectApiRoute } from "@weaver/core/projectApi/contracts";
export const runtime = "nodejs";
export async function GET(
  req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("tables"),
  );
}
export async function POST(
  req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("table.create"),
  );
}
