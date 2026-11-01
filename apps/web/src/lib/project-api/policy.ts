import { MACHINE_ACTIONS } from "@weaver/core/projectApi/constants";
import type {
  MachineAction,
  MachineTargetKind,
} from "@weaver/core/projectApi/types";

/** Documents are created through folders; every other target offers all four actions. */
export function applicableMachineActions(
  kind: MachineTargetKind,
): MachineAction[] {
  return MACHINE_ACTIONS.filter(
    (action) => kind !== "document" || action !== "create",
  );
}

export const MACHINE_ACTION_LABELS: Record<MachineAction, string> = {
  read: "Read",
  create: "Create",
  update: "Update",
  delete: "Delete",
};

export const MACHINE_TARGET_KIND_LABELS: Record<MachineTargetKind, string> = {
  document: "Document",
  documentFolder: "Document folder",
  table: "Table",
  tableFolder: "Table folder",
};
