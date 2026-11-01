import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useDocumentSectionNavigation } from "./use-document-section-navigation";

class Target {
  id = "section-deploy";
  focus = vi.fn();
  scrollIntoView = vi.fn();
  setAttribute = vi.fn();
  removeAttribute = vi.fn();
}

afterEach(() => vi.unstubAllGlobals());

it("navigates a ready editable section without focusing the editor or replaying after Save", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLElement", Target);
  const heading = new Target();
  const title = new Target();
  const highlightSection = vi.fn();
  const frames = new Map<number, () => void>();
  let frameId = 0;
  vi.stubGlobal("window", {
    document: { getElementById: () => heading },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: () => 1,
    clearTimeout: vi.fn(),
  });
  const articleRef = {
    current: {
      contains: (node: unknown) => node === heading,
    } as unknown as HTMLElement,
  };
  const titleRef = { current: title as unknown as HTMLHeadingElement };
  const navigation = {
    section: "section-deploy",
    sourceCommitSha: "a".repeat(40),
  };
  function Harness({ ready, sha }: { ready: boolean; sha: string }) {
    useDocumentSectionNavigation({
      documentId: "document",
      currentSourceSha: sha,
      articleRef,
      titleRef,
      sectionNavigation: navigation,
      editable: true,
      ready,
      highlightSection,
    });
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness ready={false} sha={"a".repeat(40)} />);
  });
  expect(heading.scrollIntoView).not.toHaveBeenCalled();
  await act(async () => {
    renderer.update(<Harness ready sha={"a".repeat(40)} />);
  });
  await act(async () => {
    for (const callback of frames.values()) callback();
    frames.clear();
  });
  expect(heading.scrollIntoView).toHaveBeenCalledTimes(1);
  expect(heading.focus).not.toHaveBeenCalled();
  expect(title.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(highlightSection).toHaveBeenCalledWith("section-deploy");
  expect(heading.setAttribute).not.toHaveBeenCalled();
  await act(async () => {
    renderer.update(<Harness ready sha={"b".repeat(40)} />);
  });
  expect(heading.scrollIntoView).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer.unmount();
  });
  expect(highlightSection).toHaveBeenLastCalledWith(null);
});

it("scrolls again for each in-page jump and puts the heading at the top", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLElement", Target);
  const heading = new Target();
  const title = new Target();
  const frames = new Map<number, () => void>();
  let frameId = 0;
  vi.stubGlobal("window", {
    document: { getElementById: () => heading },
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: () => 1,
    clearTimeout: vi.fn(),
  });
  const articleRef = {
    current: {
      contains: (node: unknown) => node === heading,
    } as unknown as HTMLElement,
  };
  const titleRef = { current: title as unknown as HTMLHeadingElement };
  function Harness({ jump }: { jump: number }) {
    useDocumentSectionNavigation({
      documentId: "document",
      currentSourceSha: "a".repeat(40),
      articleRef,
      titleRef,
      sectionNavigation: {
        section: "section-deploy",
        sourceCommitSha: "a".repeat(40),
        jump,
      },
    });
    return null;
  }
  const flush = async () => {
    await act(async () => {
      for (const callback of frames.values()) callback();
      frames.clear();
    });
  };
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness jump={1} />);
  });
  await flush();
  expect(heading.scrollIntoView).toHaveBeenCalledWith({
    behavior: "auto",
    block: "start",
  });
  expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
  await act(async () => {
    renderer.update(<Harness jump={2} />);
  });
  await flush();
  expect(heading.scrollIntoView).toHaveBeenCalledTimes(2);
  await act(async () => {
    renderer.unmount();
  });
});
