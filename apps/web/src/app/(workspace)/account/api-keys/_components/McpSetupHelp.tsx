"use client";

import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

function CopyableSnippet({ label, text }: { label: string; text: string }) {
  return (
    <div className="border-line bg-subtle min-w-0 rounded-lg border">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-text-3 text-[12px]">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Copy ${label}`}
          onClick={() => {
            if (!navigator.clipboard) {
              toast.error("Copy failed — select the text and copy manually");
              return;
            }
            void navigator.clipboard
              .writeText(text)
              .then(() => toast.success("Copied"))
              .catch(() =>
                toast.error("Copy failed — select the text and copy manually"),
              );
          }}
        >
          <Copy data-icon="inline-start" />
          Copy
        </Button>
      </div>
      <pre className="text-text-2 m-0 overflow-x-auto px-3 pb-3 text-[12px]">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function AssistantHelp({
  name,
  docs,
  children,
}: {
  name: string;
  docs: string;
  children: ReactNode;
}) {
  return (
    <details className="border-line rounded-lg border p-3">
      <summary className="text-text cursor-pointer text-[13px] font-medium">
        {name}
      </summary>
      <div className="text-text-2 mt-3 flex min-w-0 flex-col gap-3 text-[13px]">
        {children}
        <a
          href={docs}
          target="_blank"
          rel="noreferrer"
          className="text-brand w-fit underline"
        >
          {name} documentation
        </a>
      </div>
    </details>
  );
}

export function McpSetupHelp({
  mcpUrl,
  toolsets,
}: {
  mcpUrl: string;
  toolsets: ReadonlyArray<{ name: string; summary: string }>;
}) {
  const quotedUrl = `'${mcpUrl.replaceAll("'", "'\\''")}'`;
  const codexConfig = `[mcp_servers.weaver]\nurl = ${JSON.stringify(mcpUrl)}\nbearer_token_env_var = "WEAVER_API_KEY"\nhttp_headers = { "X-Weaver-Toolsets" = "write,files" }`;
  const desktopConfig = `[mcp_servers.weaver]\nurl = ${JSON.stringify(mcpUrl)}\nhttp_headers = { Authorization = "Bearer YOUR_API_KEY", "X-Weaver-Toolsets" = "write,files" }`;
  const opencodeConfig = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        weaver: {
          type: "remote",
          url: mcpUrl,
          enabled: true,
          oauth: false,
          headers: {
            Authorization: "Bearer {env:WEAVER_API_KEY}",
            "X-Weaver-Toolsets": "write,files",
          },
        },
      },
    },
    null,
    2,
  );
  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        weaver: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            mcpUrl,
            "--transport",
            "http-only",
            "--header",
            "Authorization:${WEAVER_AUTH_HEADER}",
            "--header",
            "X-Weaver-Toolsets:write,files",
          ],
          env: { WEAVER_AUTH_HEADER: "Bearer YOUR_API_KEY" },
        },
      },
    },
    null,
    2,
  );

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Connect an assistant to Weaver</CardTitle>
        <CardDescription>
          Weaver runs a remote MCP server. Create a key above, copy it when
          shown, and replace YOUR_API_KEY in the instructions on your computer.
          Keep the key and config private. The assistant can access only the
          capabilities and projects allowed by your key and your memberships.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <p>
          For a grading agent, enable the exams toolset and content:write on its
          key. Trainers review proposals and release results in Weaver.
        </p>
        <CopyableSnippet label="MCP server URL" text={mcpUrl} />
        <p className="text-text-3 m-0 text-[13px]">
          By default the server lists the core toolset: finding and reading
          documents, tables, files and graph entities, plus creating and
          patching documents. Every other tool stays reachable through
          search_tools, describe_tool and call_tool. To list more tools
          directly, send the X-Weaver-Toolsets header with comma-separated names
          (core is always included; all restores the full list).
        </p>
        <dl className="text-text-2 m-0 flex flex-col gap-1 text-[13px]">
          {toolsets.map((toolset) => (
            <div key={toolset.name} className="flex flex-wrap gap-x-2">
              <dt className="text-text font-mono">{toolset.name}</dt>
              <dd className="m-0">{toolset.summary}</dd>
            </div>
          ))}
        </dl>
        <p className="text-text-3 m-0 text-[13px]">
          Your assistant must be able to reach this URL. Enable write access on
          the key only if you want it to change content. Merge the examples into
          your existing configuration, preserving other servers.
        </p>

        <AssistantHelp
          name="Claude Code"
          docs="https://code.claude.com/docs/en/mcp"
        >
          <p className="m-0">
            With Claude Code installed, run this in a terminal. The user scope
            makes Weaver available across your projects.
          </p>
          <CopyableSnippet
            label="Claude Code command"
            text={`claude mcp add --transport http --scope user weaver ${quotedUrl} --header 'Authorization: Bearer YOUR_API_KEY' --header 'X-Weaver-Toolsets: all'`}
          />
          <p className="m-0">
            Claude Code loads tool definitions on demand, so{" "}
            <code className="font-mono">all</code> costs little there; drop the
            header elsewhere to start from core.
          </p>
          <p className="m-0">
            Restart Claude Code, then use /mcp to check the connection.
          </p>
        </AssistantHelp>

        <AssistantHelp
          name="Codex"
          docs="https://learn.chatgpt.com/docs/extend/mcp"
        >
          <p className="m-0">Add this to ~/.codex/config.toml:</p>
          <CopyableSnippet label="Codex config" text={codexConfig} />
          <p className="m-0">
            The header is optional; the example adds the write and files
            toolsets to core.
          </p>
          <p className="m-0">
            Set the key in the terminal that launches Codex (macOS/Linux):
          </p>
          <CopyableSnippet
            label="Codex launch command"
            text={"export WEAVER_API_KEY='YOUR_API_KEY'\ncodex"}
          />
          <p className="m-0">
            On Windows PowerShell, use {"$env:WEAVER_API_KEY = 'YOUR_API_KEY'"}
            before running codex. Use /mcp in Codex to check the connection.
          </p>
        </AssistantHelp>

        <AssistantHelp
          name="OpenCode"
          docs="https://opencode.ai/docs/mcp-servers/"
        >
          <p className="m-0">
            Add this to opencode.json in your project, or
            ~/.config/opencode/opencode.json for all projects:
          </p>
          <CopyableSnippet label="OpenCode config" text={opencodeConfig} />
          <p className="m-0">
            Set WEAVER_API_KEY in the terminal that launches OpenCode, as in the
            Codex instructions, then run opencode. Check with opencode mcp list.
            OAuth is disabled for this API-key connection.
          </p>
        </AssistantHelp>

        <AssistantHelp
          name="Claude Desktop"
          docs="https://github.com/punkpeye/mcp-remote"
        >
          <p className="m-0">
            For an API-key connection from your computer, install Node.js (with
            npx), then add the following to claude_desktop_config.json. The
            mcp-remote bridge connects the desktop app to Weaver over HTTP.
          </p>
          <p className="m-0">
            macOS: ~/Library/Application
            Support/Claude/claude_desktop_config.json. Windows:
            %APPDATA%\Claude\claude_desktop_config.json.
          </p>
          <CopyableSnippet
            label="Claude Desktop config"
            text={claudeDesktopConfig}
          />
          <p className="m-0">
            Fully quit and reopen Claude Desktop, then check that Weaver appears
            in its MCP tools.
          </p>
          <p className="m-0">
            Alternatively, add the URL through Settings → Connectors → Add
            custom connector and sign in to Weaver using OAuth. This account
            connector connects from Anthropic’s cloud, which must be able to
            reach your server. An OAuth connector cannot send headers: it gets
            the core toolset and reaches everything else through search_tools,
            describe_tool and call_tool.
          </p>
          <a
            href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
            target="_blank"
            rel="noreferrer"
            className="text-brand w-fit underline"
          >
            Claude remote connector help
          </a>
        </AssistantHelp>

        <AssistantHelp
          name="ChatGPT Desktop"
          docs="https://learn.chatgpt.com/docs/extend/mcp"
        >
          <p className="m-0">
            Current ChatGPT Desktop shares ~/.codex/config.toml with Codex on
            the same host. For an API-key connection, add this configuration,
            replace YOUR_API_KEY, and restart the app:
          </p>
          <CopyableSnippet
            label="ChatGPT Desktop config"
            text={desktopConfig}
          />
          <p className="m-0">
            If Weaver already exists in the file, update that entry instead of
            adding a duplicate. Remove bearer_token_env_var when using the
            static header above.
          </p>
          <p className="m-0">
            You can also open Settings → MCP servers → Add server, choose
            Streamable HTTP, enter the URL, then save and select Restart. Use
            Authenticate for an OAuth connection; use /mcp to check connected
            servers.
          </p>
        </AssistantHelp>

        <p className="text-text-3 m-0 text-[12px]">
          Setup instructions checked against the linked documentation on October
          9, 2026. If connecting fails, check the server URL, network access,
          key expiry and revocation, then restart the assistant.
        </p>
      </CardContent>
    </Card>
  );
}
