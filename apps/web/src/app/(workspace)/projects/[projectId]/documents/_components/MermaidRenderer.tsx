"use client";

import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState } from "react";

import { renderMermaidDiagram } from "~/lib/editor/mermaid-render";
import type { RenderMappings } from "~/lib/editor/render";

type MermaidRenderState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; svg: string }
  | { key: string; status: "error"; detail: string | null };

function firstErrorLine(error: unknown): string | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 240) : null;
}

export function MermaidRenderer({ source }: { source: string }) {
  const { resolvedTheme } = useTheme();
  const reactId = useId();
  const renderAttempt = useRef(0);
  const theme = resolvedTheme === "dark" ? "dark" : "default";
  const renderKey = `${theme}\0${source}`;
  const [state, setState] = useState<MermaidRenderState>(() => ({
    key: renderKey,
    status: "loading",
  }));
  const safeId = reactId.replace(/[^a-zA-Z0-9_-]/g, "") || "diagram";
  const currentState: MermaidRenderState =
    state.key === renderKey ? state : { key: renderKey, status: "loading" };

  useEffect(() => {
    let active = true;
    const attempt = ++renderAttempt.current;

    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (!active) return;

        const svg = await renderMermaidDiagram(
          mermaid,
          `weaver-mermaid-${safeId}-${attempt}`,
          source,
          theme,
        );
        if (active) setState({ key: renderKey, status: "ready", svg });
      } catch (error) {
        if (active) {
          setState({
            key: renderKey,
            status: "error",
            detail: firstErrorLine(error),
          });
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [renderKey, safeId, source, theme]);

  if (currentState.status === "error") {
    return (
      <div
        role="alert"
        className="border-danger-border bg-danger-bg text-danger rounded-lg border px-4 py-3"
      >
        <p className="m-0 font-medium">Diagram could not be rendered</p>
        {currentState.detail ? (
          <p className="text-text-2 mt-1 mb-0 text-[12px]">
            {currentState.detail}
          </p>
        ) : null}
      </div>
    );
  }

  if (currentState.status === "loading") {
    return (
      <div
        role="status"
        aria-label="Rendering Mermaid diagram"
        className="border-line bg-subtle text-text-3 flex min-h-40 animate-pulse items-center justify-center rounded-lg border px-4 py-8 text-sm"
      >
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label="Mermaid diagram"
      className="border-line bg-surface overflow-x-auto rounded-lg border p-4 [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: currentState.svg }}
    />
  );
}

export function withMermaidRendererMapping(
  nodeMapping: RenderMappings = {},
): RenderMappings {
  return {
    ...nodeMapping,
    mermaid: ({ node }) => (
      <MermaidRenderer
        source={typeof node.attrs.source === "string" ? node.attrs.source : ""}
      />
    ),
  };
}
