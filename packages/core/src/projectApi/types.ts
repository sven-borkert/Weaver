import type { MACHINE_ACTIONS, MACHINE_TARGET_KINDS } from "./constants";

export type MachineAction = (typeof MACHINE_ACTIONS)[number];
export type MachineTargetKind = (typeof MACHINE_TARGET_KINDS)[number];
export type StoredGrant = {
  kind: MachineTargetKind;
  targetId: string | null;
  root: boolean;
  actions: MachineAction[];
};
export type FolderRef = { id: string } | { root: true };
export type ProjectMachineContext = Readonly<{
  kind: "projectMachine";
  projectId: string;
  keyId: string;
  name: string;
  policyVersion: number;
}>;
export type MachineReceipt = {
  resourceId: string;
  path: string;
  revision: string;
  operationId: string;
  replayed: boolean;
  generatedIds?: { columnIds: string[]; rowIds: string[] };
};
export type MutationMeta = {
  requestId: string;
  idempotencyKey: string;
  ifMatch: string | null;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  signal?: AbortSignal;
};
