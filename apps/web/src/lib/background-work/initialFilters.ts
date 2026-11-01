import { z } from "zod";

export function initialBackgroundWorkFilters(
  params: Record<string, string | string[] | undefined>,
): { audience: "mine" | "projects"; projectId: string } {
  const projectId = z.uuid().safeParse(params.projectId);
  return {
    audience: params.audience === "projects" ? "projects" : "mine",
    projectId: projectId.success ? projectId.data : "",
  };
}
