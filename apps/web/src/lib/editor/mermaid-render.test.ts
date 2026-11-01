import type { MermaidConfig } from "mermaid";
import { describe, expect, it } from "vitest";
import {
  renderMermaidDiagram,
  type MermaidRenderRuntime,
} from "./mermaid-render";

describe("renderMermaidDiagram", () => {
  it("serializes each initialization with its render", async () => {
    const events: string[] = [];
    const configs: MermaidConfig[] = [];
    let resolveFirst: (result: { svg: string }) => void = () => undefined;
    const firstRender = new Promise<{ svg: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const runtime: MermaidRenderRuntime = {
      initialize(config) {
        configs.push(config);
        events.push(`initialize:${config.theme}`);
      },
      render(id) {
        events.push(`render:${id}`);
        return id === "first"
          ? firstRender
          : Promise.resolve({ svg: "<svg>second</svg>" });
      },
    };

    const first = renderMermaidDiagram(
      runtime,
      "first",
      "invalid diagram",
      "default",
    );
    const second = renderMermaidDiagram(
      runtime,
      "second",
      "flowchart TD; A-->B;",
      "dark",
    );

    await Promise.resolve();
    expect(events).toEqual(["initialize:default", "render:first"]);

    resolveFirst({ svg: "<svg>first</svg>" });
    await expect(first).resolves.toBe("<svg>first</svg>");
    await expect(second).resolves.toBe("<svg>second</svg>");

    expect(events).toEqual([
      "initialize:default",
      "render:first",
      "initialize:dark",
      "render:second",
    ]);
    expect(configs).toEqual([
      {
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "default",
      },
      {
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "dark",
      },
    ]);
  });

  it("runs the next operation after a rejection", async () => {
    const events: string[] = [];
    const runtime: MermaidRenderRuntime = {
      initialize(config) {
        events.push(`initialize:${config.theme}`);
      },
      render(id) {
        events.push(`render:${id}`);
        return id === "first"
          ? Promise.reject(new Error("first failed"))
          : Promise.resolve({ svg: "<svg>second</svg>" });
      },
    };

    const first = renderMermaidDiagram(
      runtime,
      "first",
      "invalid diagram",
      "default",
    );
    const second = renderMermaidDiagram(
      runtime,
      "second",
      "flowchart TD; A-->B;",
      "dark",
    );

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("<svg>second</svg>");
    expect(events).toEqual([
      "initialize:default",
      "render:first",
      "initialize:dark",
      "render:second",
    ]);
  });
});
