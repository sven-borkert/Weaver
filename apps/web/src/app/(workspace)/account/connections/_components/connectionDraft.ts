import { externalEndpointSchema } from "@weaver/core/externalMcp/schema";
import { z } from "zod";

export const connectionFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  endpoint: externalEndpointSchema,
  authMode: z.enum(["none", "bearer"]),
  token: z.string().max(16_384),
  timeoutMs: z.number().int().min(5_000).max(120_000),
  enabled: z.boolean(),
  allowInsecureTls: z.boolean(),
});
export type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

export type ConnectionDraftIdentity = {
  id: string;
  revision: number;
};

export type ConnectionDraftState = {
  identity: ConnectionDraftIdentity | null;
};

export function connectionDefaults(connection?: {
  name: string;
  endpoint: string;
  authMode: "none" | "bearer";
  timeoutMs: number;
  enabled: boolean;
  allowInsecureTls: boolean;
}): ConnectionFormValues {
  return {
    name: connection?.name ?? "",
    endpoint: connection?.endpoint ?? "",
    authMode: connection?.authMode ?? "none",
    token: "",
    timeoutMs: connection?.timeoutMs ?? 30_000,
    enabled: connection?.enabled ?? false,
    allowInsecureTls: connection?.allowInsecureTls ?? false,
  };
}

export type DraftConnection = NonNullable<
  Parameters<typeof connectionDefaults>[0]
> & {
  id: string;
  revision: number;
};

export function startConnectionDraft(
  connection?: DraftConnection,
): ConnectionDraftState {
  return {
    identity: connection
      ? { id: connection.id, revision: connection.revision }
      : null,
  };
}

export function connectionDraftReducer(
  _state: ConnectionDraftState,
  action: { type: "open" | "saved"; connection?: DraftConnection },
): ConnectionDraftState {
  return startConnectionDraft(action.connection);
}

export function tokenPatch(values: ConnectionFormValues) {
  return values.authMode === "bearer" && values.token
    ? { token: values.token }
    : {};
}

export function needsTokenReentry(
  connection: { endpoint: string; authMode: "none" | "bearer" } | undefined,
  values: Pick<ConnectionFormValues, "endpoint" | "authMode" | "token">,
) {
  if (connection?.authMode !== "bearer" || values.authMode !== "bearer")
    return false;
  if (values.token) return false;
  try {
    return (
      new URL(values.endpoint).origin !== new URL(connection.endpoint).origin
    );
  } catch {
    return false;
  }
}

export function connectionPatch(values: ConnectionFormValues) {
  return {
    name: values.name,
    endpoint: values.endpoint,
    authMode: values.authMode,
    ...tokenPatch(values),
    timeoutMs: values.timeoutMs,
    enabled: values.enabled,
    allowInsecureTls: values.allowInsecureTls,
  };
}

export function updateInput(
  identity: ConnectionDraftIdentity,
  values: ConnectionFormValues,
) {
  return {
    id: identity.id,
    expectedRevision: identity.revision,
    patch: connectionPatch(values),
  };
}
