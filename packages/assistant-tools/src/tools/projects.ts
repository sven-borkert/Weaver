import { listProjectsForUser } from "@weaver/core/services/projects";
import { z } from "zod";
import { boundItems, defineTool, newOutputBudget } from "../contract";

export const listProjectsTool = defineTool({
  name: "list_projects",
  kind: "read",
  capability: "content:read",
  description:
    "List the projects in the current conversation scope with the user's role in each. Call this first when unsure which project ids are available.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const projects = await listProjectsForUser(ctx.db, ctx.actor);
    const inScope = projects.filter((project) =>
      ctx.scope.projectIds.includes(project.id),
    );
    const mapped = inScope.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      role: project.myRole,
    }));
    // Scope allows up to 100 projects (scope.ts) with descriptions up to
    // 2000 chars each; bound the aggregate rather than risk an oversized call.
    const { items: boundedProjects, truncated: outputTruncated } = boundItems(
      mapped,
      newOutputBudget(),
    );
    return {
      output: {
        scope: {
          kind: ctx.scope.kind,
          documentId: ctx.scope.documentId,
          tableId: ctx.scope.tableId,
        },
        truncated: ctx.scope.truncated || outputTruncated,
        projects: boundedProjects,
      },
    };
  },
});
