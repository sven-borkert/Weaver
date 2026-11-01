import type { MermaidConfig } from "mermaid";

export type MermaidRenderRuntime = {
  initialize: (config: MermaidConfig) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
};

let renderQueue: Promise<void> = Promise.resolve();

export function renderMermaidDiagram(
  runtime: MermaidRenderRuntime,
  id: string,
  source: string,
  theme: "dark" | "default",
): Promise<string> {
  const operation = renderQueue.then(async () => {
    runtime.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme,
    });
    const { svg } = await runtime.render(id, source);
    return svg;
  });
  renderQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
