import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  onProgress: null as ((percentage: number) => void) | null,
  resolve: null as ((result: unknown) => void) | null,
}));
vi.mock("sonner", () => ({ toast: { success: () => undefined } }));
vi.mock("./uploadArtifacts", () => ({
  uploadArtifacts: (
    _projectId: string,
    _files: File[],
    _replace: string[],
    options: { onProgress?: (percentage: number) => void },
  ) =>
    new Promise((resolve) => {
      mocked.onProgress = options.onProgress ?? null;
      mocked.resolve = resolve;
    }),
}));
// Radix Dialog's Portal needs a DOM `document`; the vitest environment is "node".
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));

import { ArtifactUpload } from "./ArtifactUpload";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  projectId: "22222222-2222-4222-8222-222222222222",
  maxFileBytes: 2048,
  existingFilenames: ["Plan.docx"],
  onUploaded: () => undefined,
};

const render = () => renderToStaticMarkup(<ArtifactUpload {...props} />);

describe("ArtifactUpload", () => {
  it("offers a labelled multi-file drop zone that accepts any file type", () => {
    const html = render();
    expect(html).toContain('aria-label="Upload files"');
    expect(html).toContain("Drop files here");
    expect(html).toContain("multiple=");
    expect(html).not.toContain("accept=");
  });

  it("states the batch and size limits and starts idle", () => {
    const html = render();
    expect(html).toContain("Up to 20 files");
    expect(html).toContain("2.0 KB");
    expect(html).not.toContain("Cancel upload");
    expect(html).not.toContain("Replace");
    expect(html).not.toContain('role="alert"');
    // The live region is present but silent before an upload starts.
    expect(html).toContain('<span role="status" class="sr-only"></span>');
  });

  describe("while uploading", () => {
    const renderers: ReactTestRenderer[] = [];
    afterEach(() => {
      for (const renderer of renderers.splice(0)) renderer.unmount();
      mocked.onProgress = null;
      mocked.resolve = null;
    });

    async function mountAndStart() {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<ArtifactUpload {...props} />, {
          createNodeMock: () => ({ value: "" }),
        });
      });
      renderers.push(renderer);
      const input = renderer.root.findByProps({
        "aria-label": "Choose files to upload",
      });
      await act(async () => {
        (input.props.onChange as (e: unknown) => void)({
          target: { files: [new File(["abc"], "New.txt")] },
        });
      });
      return renderer;
    }

    const text = (node: ReactTestInstance) =>
      node.children.filter((child) => typeof child === "string").join("");
    const status = (renderer: ReactTestRenderer) =>
      text(renderer.root.findByProps({ role: "status" }));
    const dropZone = (renderer: ReactTestRenderer) =>
      renderer.root.find(
        (node) => node.type === "div" && "aria-busy" in node.props,
      );

    it("marks the drop zone busy and announces 25 % milestones, then the finishing step", async () => {
      const renderer = await mountAndStart();
      expect(mocked.onProgress).not.toBeNull();
      expect(dropZone(renderer).props["aria-busy"]).toBe(true);
      expect(status(renderer)).toBe("Uploading… 0%");

      for (const [percent, announced] of [
        [10, "Uploading… 0%"],
        [24, "Uploading… 0%"],
        [25, "Uploading… 25%"],
        [49, "Uploading… 25%"],
        [50, "Uploading… 50%"],
        [80, "Uploading… 75%"],
        [100, "Files sent. Finishing upload…"],
      ] as const) {
        await act(async () => mocked.onProgress!(percent));
        expect(status(renderer)).toBe(announced);
        expect(text(renderer.root.findAllByType("p")[0]!)).toBe(
          percent === 100
            ? "Files sent. Finishing upload…"
            : `Uploading… ${percent}%`,
        );
      }

      await act(async () => mocked.resolve!({ kind: "uploaded", count: 1 }));
      expect(dropZone(renderer).props["aria-busy"]).toBe(false);
      expect(status(renderer)).toBe("");
    });
  });
});
