import {
  MCP_TOOLSET_NAMES,
  MCP_TOOLSET_SUMMARIES,
} from "@weaver/assistant-tools/toolsetNames";
import { headers } from "next/headers";

import { getSessionUser, MCP_RESOURCE_URL } from "~/server/auth";
import { ApiKeysCard } from "./_components/ApiKeysCard";
import { McpSetupHelp } from "./_components/McpSetupHelp";

export default async function ApiKeysPage() {
  const user = await getSessionUser(await headers());
  const toolsets = MCP_TOOLSET_NAMES.map((name) => ({
    name,
    summary: MCP_TOOLSET_SUMMARIES[name],
  }));
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-text m-0 text-[20px] font-semibold">API keys</h1>
        <p className="text-text-3 m-0 text-[13px]">
          A tool using one of these keys acts as you, limited to the
          capabilities and projects you select here. Keys are shown once when
          created.
        </p>
      </div>
      <ApiKeysCard isAdmin={user?.role === "Admin"} />
      <McpSetupHelp mcpUrl={MCP_RESOURCE_URL} toolsets={toolsets} />
    </div>
  );
}
