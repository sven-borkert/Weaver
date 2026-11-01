export const MAX_FIND_MATCHES = 10;
export const MAX_FIND_DESCRIPTION_CHARS = 300;
export const MAX_SCHEMA_RESERVE_BYTES = 32_768;

export type SearchableExternalTool = {
  name: string;
  tool: string;
  connection: string;
  description: string;
  effect: "read" | "write";
};

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

export function rankExternalTools<T extends SearchableExternalTool>(
  tools: readonly T[],
  input: { query?: string; connection?: string },
): { matches: T[]; total: number } {
  const connection = input.connection?.toLowerCase();
  const words = terms(input.query ?? "");
  const scored = tools.flatMap((tool) => {
    const connectionName = tool.connection.toLowerCase();
    if (connection && !connectionName.includes(connection)) return [];
    const name = tool.tool.toLowerCase();
    const description = tool.description.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (name.includes(word)) score += 3;
      if (connectionName.includes(word)) score += 2;
      if (description.includes(word)) score += 1;
    }
    return words.length && score === 0 ? [] : [{ tool, score }];
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.tool.tool.localeCompare(b.tool.tool) ||
      a.tool.name.localeCompare(b.tool.name),
  );
  return {
    matches: scored.slice(0, MAX_FIND_MATCHES).map((entry) => entry.tool),
    total: scored.length,
  };
}

export function externalSchemaReserve(contextWindow: number): number {
  return Math.max(
    0,
    Math.min(MAX_SCHEMA_RESERVE_BYTES, Math.floor(contextWindow / 8)),
  );
}

export function externalDefinitionBytes(definition: {
  name: string;
  description: string;
  inputSchema: unknown;
}): number {
  return Buffer.byteLength(JSON.stringify(definition), "utf8");
}
