import {
  resolveCitationInputSchema,
  validateSourceLocators,
} from "@weaver/core/assistant/citations";
import type { CitationView } from "@weaver/core/assistant/events";
import { defineTool, requireScope, type ToolOutcome } from "../contract";

type ResolveCitationOutput =
  | {
      valid: true;
      kind: CitationView["kind"];
      label: string;
      resourceId: string;
      commitSha: string | null;
    }
  | { valid: false };

export const resolveCitationTool = defineTool({
  name: "resolve_citation",
  kind: "read",
  capability: "content:read",
  description:
    "Validate a source locator (document/table/graph/search) and get its display label. Use before citing something you did not read in this run.",
  inputSchema: resolveCitationInputSchema,
  async execute(input, ctx): Promise<ToolOutcome<ResolveCitationOutput>> {
    requireScope(ctx, input.projectId);
    const [citation] = await validateSourceLocators(ctx.db, ctx.actor, [input]);
    return citation
      ? {
          output: {
            valid: true,
            kind: citation.kind,
            label: citation.label,
            resourceId: citation.resourceId,
            commitSha: citation.commitSha,
          },
          citations: [input],
        }
      : { output: { valid: false } };
  },
});
