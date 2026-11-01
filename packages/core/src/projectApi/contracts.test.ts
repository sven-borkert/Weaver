import { describe, expect, it } from "vitest";
import { projectApiRoutes, buildProjectApiOpenApi } from "./contracts";
describe("project API contract", () => {
  it("documents every distinct operation, path parameter and request schema", () => {
    const api = buildProjectApiOpenApi() as {
      paths: Record<
        string,
        Record<
          string,
          { parameters: { name: string; in: string }[]; requestBody?: unknown }
        >
      >;
    };
    expect(projectApiRoutes).toHaveLength(17);
    expect(new Set(projectApiRoutes.map((r) => r.operation)).size).toBe(17);
    for (const route of projectApiRoutes) {
      const documented = api.paths[route.path]![route.method.toLowerCase()]!;
      expect(
        documented.parameters.filter((p) => p.in === "path").map((p) => p.name),
      ).toEqual([...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
      expect(Boolean(documented.requestBody)).toBe(Boolean(route.request));
      if (route.mutation)
        expect(documented.parameters).toContainEqual(
          expect.objectContaining({ name: "Idempotency-Key" }),
        );
    }
  });
});
