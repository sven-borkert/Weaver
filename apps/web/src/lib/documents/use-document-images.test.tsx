import { Editor } from "@tiptap/react";
import { documentExtensions } from "@weaver/core/editor/extensions";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ImageUpload from "./image-upload";
import { useDocumentImages } from "./use-document-images";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    loading: mocks.loading,
    success: mocks.success,
    error: mocks.error,
    dismiss: mocks.dismiss,
  },
}));
vi.mock("./image-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUpload>()),
  uploadDocumentImage: mocks.upload,
}));

type UploadedDocumentImage = ImageUpload.UploadedDocumentImage;
const stored: UploadedDocumentImage = {
  src: "overview.assets/diagram.png",
  path: "overview.assets/diagram.png",
  url: "/image",
  contentType: "image/png",
  byteSize: 5,
  commitSha: "a".repeat(40),
};
const file = () =>
  new File(["image"], "sample-diagram.png", { type: "image/png" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const cleanups: (() => void)[] = [];

async function mountImages() {
  const editor = new Editor({
    element: null,
    extensions: documentExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "abc" }] },
      ],
    },
  });
  // Keep real TipTap state and transactions while simulating a live view in Node.
  vi.spyOn(editor, "isDestroyed", "get").mockReturnValue(false);
  let images!: ReturnType<typeof useDocumentImages>;
  let renderer!: ReactTestRenderer;
  let canEdit = true;
  let mounted = true;
  function Harness() {
    images = useDocumentImages({
      editor,
      projectId: "project",
      documentId: "document",
      canEdit,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  cleanups.push(() => {
    if (mounted) renderer.unmount();
    editor.destroy();
  });
  return {
    editor,
    get images() {
      return images;
    },
    async demote() {
      canEdit = false;
      await act(async () => {
        renderer.update(<Harness />);
      });
    },
    async unmount() {
      await act(async () => {
        renderer.unmount();
        mounted = false;
      });
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.loading.mockReturnValue("upload-toast");
  mocks.upload.mockResolvedValue(stored);
});
afterEach(async () => {
  await act(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("document image upload lifecycle", () => {
  it.each(["discard", "demotion", "unmount"] as const)(
    "aborts pending uploads on %s and never inserts a late response or sends queued files",
    async (reason) => {
      const response = deferred<UploadedDocumentImage>();
      mocks.upload.mockReturnValue(response.promise);
      const mounted = await mountImages();
      const original = mounted.editor.state.doc;
      let upload!: Promise<void>;
      await act(async () => {
        upload = mounted.images.upload([file(), file()], 2);
      });
      expect(mounted.images.hasPending()).toBe(true);
      expect(mounted.images.pending).toBe(2);
      expect(mocks.upload).toHaveBeenCalledOnce();
      const signal = (
        mocks.upload.mock.calls[0]?.[0] as { signal: AbortSignal }
      ).signal;
      expect(signal.aborted).toBe(false);
      if (reason === "discard")
        await act(async () => {
          mounted.images.cancel();
        });
      else if (reason === "demotion") await mounted.demote();
      else await mounted.unmount();
      expect(signal.aborted).toBe(true);
      expect(mounted.images.hasPending()).toBe(false);
      if (reason !== "unmount") expect(mounted.images.pending).toBe(0);
      await act(async () => {
        response.resolve(stored);
        await upload;
      });
      expect(mounted.editor.state.doc.eq(original)).toBe(true);
      expect(mocks.upload).toHaveBeenCalledOnce();
      expect(mocks.success).not.toHaveBeenCalled();
      expect(mocks.error).not.toHaveBeenCalled();
      expect(mocks.dismiss).toHaveBeenCalledWith("upload-toast");
    },
  );

  it("maps a pending insertion point through edits and inserts a completed image once", async () => {
    const response = deferred<UploadedDocumentImage>();
    mocks.upload.mockReturnValue(response.promise);
    const mounted = await mountImages();
    let upload!: Promise<void>;
    await act(async () => {
      upload = mounted.images.upload([file()], 2);
    });
    expect(mounted.images.pending).toBe(1);
    await act(async () => {
      mounted.editor.view.dispatch(mounted.editor.state.tr.insertText("XX", 1));
    });
    await act(async () => {
      response.resolve(stored);
      await upload;
    });
    const blocks: { type: string; text: string; src: unknown; alt: unknown }[] =
      [];
    mounted.editor.state.doc.forEach((node) => {
      blocks.push({
        type: node.type.name,
        text: node.textContent,
        src: node.attrs.src,
        alt: node.attrs.alt,
      });
    });
    expect(blocks).toEqual([
      { type: "paragraph", text: "XXa", src: undefined, alt: undefined },
      { type: "image", text: "", src: stored.src, alt: "sample diagram" },
      { type: "paragraph", text: "bc", src: undefined, alt: undefined },
    ]);
    expect(mounted.images.pending).toBe(0);
    expect(mounted.images.hasPending()).toBe(false);
    expect(mocks.success).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("refuses new uploads after permission loss", async () => {
    const mounted = await mountImages();
    await mounted.demote();
    await act(async () => {
      await mounted.images.upload([file()]);
    });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mounted.images.pending).toBe(0);
  });
});
