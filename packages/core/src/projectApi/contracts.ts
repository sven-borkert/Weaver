import { z } from "zod";
import {
  machineUuid,
  machineAction,
  machineColumn,
  machineRow,
  documentCreateBody,
  documentReplaceBody,
  tableCreateBody,
  tableReplaceBody,
  rowsAppendBody,
  rowsUpdateBody,
} from "./schemas";
import { MACHINE_TARGET_KINDS } from "./constants";
const revision = z.string().regex(/^[a-f0-9]{40}$/);
export const machineReceiptSchema = z.strictObject({
  resourceId: machineUuid,
  path: z.string(),
  revision,
  operationId: machineUuid,
  replayed: z.boolean(),
  generatedIds: z
    .strictObject({
      columnIds: z.array(machineUuid),
      rowIds: z.array(machineUuid),
    })
    .optional(),
});
const metadata = z.strictObject({
  id: machineUuid,
  path: z.string(),
  title: z.string(),
  revision,
});
const page = z.strictObject({
  items: z.array(metadata),
  nextCursor: z.string().nullable(),
});
const document = metadata.extend({ markdown: z.string() });
const table = metadata.extend({
  columns: z.array(machineColumn),
  rows: z.array(machineRow),
});
const grants = z.strictObject({
  grants: z.array(
    z.strictObject({
      kind: z.enum(MACHINE_TARGET_KINDS),
      targetId: machineUuid.nullable(),
      root: z.boolean(),
      actions: z.array(machineAction),
      available: z.boolean(),
      path: z.string().optional(),
      revision: revision.optional(),
    }),
  ),
});
export const machineErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ProjectApiRouteParams = {
  projectId: string;
  documentId?: string;
  tableId?: string;
  rowId?: string;
};
export type ProjectApiRouteContract = {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  operation: string;
  request?: z.ZodType;
  response?: z.ZodType;
  paginated?: boolean;
  mutation: boolean;
  status: number;
};
const base = "/api/v1/projects/{projectId}";
export const projectApiRoutes: readonly ProjectApiRouteContract[] = [
  {
    method: "GET",
    path: `${base}/grants`,
    operation: "grants",
    response: grants,
    mutation: false,
    status: 200,
  },
  {
    method: "GET",
    path: `${base}/documents`,
    operation: "documents",
    response: page,
    paginated: true,
    mutation: false,
    status: 200,
  },
  {
    method: "POST",
    path: `${base}/documents`,
    operation: "document.create",
    request: documentCreateBody,
    response: machineReceiptSchema,
    mutation: true,
    status: 201,
  },
  {
    method: "GET",
    path: `${base}/documents/{documentId}`,
    operation: "document.get",
    response: document,
    mutation: false,
    status: 200,
  },
  {
    method: "HEAD",
    path: `${base}/documents/{documentId}`,
    operation: "document.head",
    mutation: false,
    status: 200,
  },
  {
    method: "PUT",
    path: `${base}/documents/{documentId}`,
    operation: "document.replace",
    request: documentReplaceBody,
    response: machineReceiptSchema,
    mutation: true,
    status: 200,
  },
  {
    method: "DELETE",
    path: `${base}/documents/{documentId}`,
    operation: "document.delete",
    response: machineReceiptSchema,
    mutation: true,
    status: 200,
  },
  {
    method: "GET",
    path: `${base}/tables`,
    operation: "tables",
    response: page,
    paginated: true,
    mutation: false,
    status: 200,
  },
  {
    method: "POST",
    path: `${base}/tables`,
    operation: "table.create",
    request: tableCreateBody,
    response: machineReceiptSchema,
    mutation: true,
    status: 201,
  },
  {
    method: "GET",
    path: `${base}/tables/{tableId}`,
    operation: "table.get",
    response: table,
    mutation: false,
    status: 200,
  },
  {
    method: "HEAD",
    path: `${base}/tables/{tableId}`,
    operation: "table.head",
    mutation: false,
    status: 200,
  },
  {
    method: "PUT",
    path: `${base}/tables/{tableId}`,
    operation: "table.replace",
    request: tableReplaceBody,
    response: machineReceiptSchema,
    mutation: true,
    status: 200,
  },
  {
    method: "DELETE",
    path: `${base}/tables/{tableId}`,
    operation: "table.delete",
    response: machineReceiptSchema,
    mutation: true,
    status: 200,
  },
  {
    method: "GET",
    path: `${base}/tables/{tableId}/rows`,
    operation: "table.rows",
    response: z.strictObject({
      revision,
      items: z.array(machineRow),
      nextCursor: z.string().nullable(),
    }),
    paginated: true,
    mutation: false,
    status: 200,
  },
  {
    method: "POST",
    path: `${base}/tables/{tableId}/rows`,
    operation: "rows.append",
    request: rowsAppendBody,
    response: machineReceiptSchema,
    mutation: true,
    status: 200,
  },
  {
    method: "PATCH",
    path: `${base}/tables/{tableId}/rows`,
    operation: "rows.update",
    request: rowsUpdateBody,
    response: machineReceiptSchema,
    mutation: true,
    status: 200,
  },
  {
    method: "DELETE",
    path: `${base}/tables/{tableId}/rows/{rowId}`,
    operation: "rows.delete",
    response: machineReceiptSchema,
    mutation: true,
    status: 200,
  },
];
export function projectApiRoute(operation: string) {
  const route = projectApiRoutes.find((r) => r.operation === operation);
  if (!route) throw new Error("Unknown project API operation");
  return route;
}
export function buildProjectApiOpenApi(): object {
  const paths: Record<string, Record<string, unknown>> = {};
  const schema = (value: z.ZodType, input = false) =>
    z.toJSONSchema(value, {
      target: "draft-2020-12",
      io: input ? "input" : "output",
    });
  for (const route of projectApiRoutes) {
    const parameters: Record<string, unknown>[] = [
      ...route.path.matchAll(/\{(\w+)\}/g),
    ].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: schema(machineUuid),
    }));
    if (route.paginated)
      parameters.push(
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        {
          name: "cursor",
          in: "query",
          schema: { type: "string", maxLength: 4096 },
          description:
            "Opaque cursor bound to this key, policy, query and repository snapshot.",
        },
      );
    if (route.mutation)
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{8,128}$" },
        description:
          "Unique within this key across endpoints. Receipts retained for 30 days.",
      });
    if (route.mutation && !route.operation.endsWith(".create"))
      parameters.push({
        name: "If-Match",
        in: "header",
        required: true,
        schema: { type: "string", pattern: '^"[a-f0-9]{40}"$' },
        description: "Single strong resource revision from HEAD or GET.",
      });
    const headers = {
      "X-Request-Id": { schema: { type: "string" } },
      "Cache-Control": { schema: { type: "string", const: "no-store" } },
      ETag: { schema: { type: "string" } },
    };
    const responses: Record<string, unknown> = {
      [route.status]: {
        description: route.mutation
          ? "Metadata-only receipt; no content returned."
          : "Authorized result",
        headers,
        ...(route.response
          ? {
              content: {
                "application/json": { schema: schema(route.response) },
              },
            }
          : {}),
      },
    };
    for (const status of [
      400, 401, 403, 404, 409, 412, 413, 415, 428, 429, 500,
    ])
      responses[status] = {
        description: "Request rejected",
        content: { "application/json": { schema: schema(machineErrorSchema) } },
        ...(status === 429
          ? {
              headers: {
                "Retry-After": { schema: { type: "integer", minimum: 1 } },
              },
            }
          : {}),
      };
    paths[route.path] ??= {};
    paths[route.path]![route.method.toLowerCase()] = {
      operationId: route.operation.replace(/\./g, "_"),
      security: [{ projectKey: [] }],
      parameters,
      responses,
      ...(route.request
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: schema(route.request, true) },
              },
            },
          }
        : {}),
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Weaver project machine API",
      version: "1.0.0",
      description:
        "Project-owned bearer keys with independent Read/Create/Update/Delete grants. Folder grants cover descendants and future content. Markdown only. Table replacement also requires Create for added rows and Delete for removed rows, columns or options. HEAD grants revision access for applicable actions. Every mutation requires Idempotency-Key; item mutations require If-Match. JSON bodies are limited to 5 MiB.",
    },
    servers: [
      {
        url: "{origin}{basePath}",
        variables: {
          origin: { default: "http://localhost:3000" },
          basePath: {
            default: "",
            description: "Deployment prefix, for example /weaver",
          },
        },
      },
    ],
    components: {
      securitySchemes: {
        projectKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "wvr_project_<uuid>.<secret>",
        },
      },
    },
    paths,
  };
}
