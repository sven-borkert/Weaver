export type ScopeDescription = {
  title: string;
  detail: string;
  write: boolean;
};

const DESCRIPTIONS: Record<string, ScopeDescription> = {
  "mcp:use": {
    title: "Connect through MCP",
    detail: "Use the Weaver MCP server with this client.",
    write: false,
  },
  "content:read": {
    title: "Read your projects",
    detail:
      "Read documents, tables, and the knowledge graph in projects you belong to.",
    write: false,
  },
  "content:propose": {
    title: "Propose changes",
    detail:
      "Create change proposals that you review and accept before anything is saved.",
    write: false,
  },
  "content:write": {
    title: "Edit content directly",
    detail:
      "Create, edit, and delete documents and tables as you, without review. Only grant this to tools you trust.",
    write: true,
  },
  "external:use": {
    title: "Use your MCP connections",
    detail:
      "Call the tools you enabled on your own MCP connections. Calls act as you in those apps.",
    write: false,
  },
  "external:manage": {
    title: "Manage your MCP connections",
    detail:
      "Add, change and delete your MCP connections, including their tokens, and choose which of their tools are enabled.",
    write: true,
  },
  offline_access: {
    title: "Stay connected",
    detail: "Keep working without signing in again (refresh tokens).",
    write: false,
  },
};

export function describeScope(scope: string): ScopeDescription {
  return (
    DESCRIPTIONS[scope] ?? {
      title: scope,
      detail: "Requested by the client; Weaver does not recognize this scope.",
      write: false,
    }
  );
}

export function parseRequestedScopes(scope: string | undefined): string[] {
  return [...new Set((scope ?? "").split(" ").filter(Boolean))];
}
