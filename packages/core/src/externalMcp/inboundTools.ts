import { createHash } from "node:crypto";

export const EXTERNAL_TOOL_PREFIX = "ext_";
const MAX_NAME = 64;

function suffix(connectionId: string, remoteName: string) {
  return createHash("sha256")
    .update(`${connectionId}:${remoteName}`)
    .digest("hex")
    .slice(0, 6);
}

export function assignInboundToolNames(
  entries: Array<{
    connectionId: string;
    connectionName: string;
    remoteName: string;
  }>,
): string[] {
  const bases = entries.map(
    (entry) =>
      `${EXTERNAL_TOOL_PREFIX}${entry.connectionName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}__${entry.remoteName.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
  );
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  return bases.map((base, index) => {
    if (base.length <= MAX_NAME && counts.get(base) === 1) return base;
    const entry = entries[index]!;
    const tail = `_${suffix(entry.connectionId, entry.remoteName)}`;
    return `${base.slice(0, MAX_NAME - tail.length)}${tail}`;
  });
}
