import { listContentFolders } from "@weaver/core/services/folders";
import { z } from "zod";
import {
  boundItems,
  defineSharedReadTool,
  newPageBudget,
  requireScope,
} from "../contract";

export const listContentFoldersTool = defineSharedReadTool({
  name: "list_content_folders",
  kind: "read",
  capability: "content:read",
  description:
    "List a project's folders for documents or tables at one pinned project revision. Returns baseProjectCommitSha, which content_lifecycle requires for every folder action.",
  inputSchema: z.object({
    projectId: z.uuid(),
    resourceType: z.enum(["document", "table"]).optional(),
  }),
  async execute(input, ctx) {
    requireScope(ctx, input.projectId);
    const listing = await listContentFolders(ctx.db, input, ctx.actor);
    const { items: folders, truncated } = boundItems(
      listing.folders,
      newPageBudget(),
    );
    return {
      output: {
        baseProjectCommitSha: listing.baseProjectCommitSha,
        folders,
        // The listing is not paged: a project with more folders than fit is
        // reported as shortened rather than silently halved.
        truncated,
      },
    };
  },
});
