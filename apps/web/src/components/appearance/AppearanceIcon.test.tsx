import { FileText } from "lucide-react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("~/lib/basePath", () => ({
  withBasePath: (path: string) => `/weaver${path}`,
}));
import { AppearanceIcon, appearanceIconUrl } from "./AppearanceIcon";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppearanceIcon", () => {
  it("leaves native dragging to the containing explorer item", () => {
    const markup = renderToStaticMarkup(
      <AppearanceIcon
        projectId="p1"
        appearance={{
          icon: { type: "image", digest: "a".repeat(64), extension: "png" },
        }}
        fallback={FileText}
        size={24}
      />,
    );
    expect(markup).toContain('draggable="false"');
  });

  it("broken_image_uses_named_fallback", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AppearanceIcon
          projectId="p1"
          appearance={{
            icon: { type: "image", digest: "a".repeat(64), extension: "png" },
          }}
          fallback={FileText}
          size={24}
        />,
      );
    });
    expect(renderer.root.findByType("img").props.src).toBe(
      `/weaver/api/projects/p1/icons/${"a".repeat(64)}.png`,
    );
    await act(async () =>
      (renderer.root.findByType("img").props.onError as () => void)(),
    );
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(renderer.root.findByType("svg").props["data-fallback"]).toBe(
      "file-text",
    );
    await act(async () => renderer.unmount());
  });
  it("builds committed revision URLs below the configured base path", () => {
    expect(
      appearanceIconUrl(
        "project one",
        { type: "image", digest: "a".repeat(64), extension: "webp" },
        "b".repeat(40),
      ),
    ).toBe(
      `/weaver/api/projects/project%20one/icons/${"a".repeat(64)}.webp?at=${"b".repeat(40)}`,
    );
  });
  it.each([24, 40])("contains emoji icons at %s px", (size) => {
    const element = (
      <AppearanceIcon
        projectId="p1"
        appearance={{ icon: { type: "emoji", value: "📚" } }}
        fallback={FileText}
        size={size}
      />
    );
    const server = renderToStaticMarkup(element);
    expect(server).toContain(`width:${size}px`);
    expect(server).toContain(`height:${size}px`);
    expect(server).toContain("📚");
  });
});
