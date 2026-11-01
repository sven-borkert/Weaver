import { handleProjectApiRequest } from "~/server/projectApi/dispatch";
import { projectApiRoute } from "@weaver/core/projectApi/contracts";
export const runtime = "nodejs";
export async function DELETE(
  req: Request,
  context: {
    params: Promise<{ projectId: string; tableId: string; rowId: string }>;
  },
) {
  return handleProjectApiRequest(
    req,
    await context.params,
    projectApiRoute("rows.delete"),
  );
}
