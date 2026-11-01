export const WORKER_ROLES = [
  "knowledge",
  "assistant",
  "ingestion",
  "tasks",
  "git",
] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];
export const DEFAULT_WORKER_ROLES = WORKER_ROLES.join(",");

function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

/** Comma-separated roles; order follows the input, duplicates collapse. */
export function parseWorkerRoles(value: string): ReadonlySet<WorkerRole> {
  const roles = new Set<WorkerRole>();
  for (const raw of value.split(",")) {
    const role = raw.trim().toLowerCase();
    if (role === "") continue;
    if (!isWorkerRole(role)) {
      throw new Error(`unknown worker role "${raw.trim()}"`);
    }
    roles.add(role);
  }
  if (roles.size === 0) {
    throw new Error("WEAVER_WORKER_ROLES must name at least one role");
  }
  return roles;
}
