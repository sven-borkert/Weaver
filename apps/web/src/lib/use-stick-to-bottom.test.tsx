import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useStickToBottom } from "./use-stick-to-bottom";

afterEach(() => vi.unstubAllGlobals());

it("follows new content only until the reader scrolls away, then resumes near the bottom", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scroller = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
  function Harness({ revision }: { revision: number }) {
    const { scrollRef, onScroll, jumpToLatest } = useStickToBottom(revision);
    return (
      <div ref={scrollRef} onScroll={onScroll}>
        <button onClick={jumpToLatest}>Latest</button>
      </div>
    );
  }
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<Harness revision={0} />, {
      createNodeMock: () => scroller,
    });
  });
  try {
    expect(scroller.scrollTop).toBe(1000);
    scroller.scrollTop = 100;
    await act(() =>
      (
        renderer.root.findByType("div").props as { onScroll: () => void }
      ).onScroll(),
    );
    scroller.scrollHeight = 1200;
    await act(() => renderer.update(<Harness revision={1} />));
    expect(scroller.scrollTop).toBe(100);
    scroller.scrollTop = 780;
    await act(() =>
      (
        renderer.root.findByType("div").props as { onScroll: () => void }
      ).onScroll(),
    );
    scroller.scrollHeight = 1400;
    await act(() => renderer.update(<Harness revision={2} />));
    expect(scroller.scrollTop).toBe(1400);
    scroller.scrollTop = 10;
    await act(() =>
      (
        renderer.root.findByType("div").props as { onScroll: () => void }
      ).onScroll(),
    );
    await act(() =>
      (
        renderer.root.findByType("button").props as { onClick: () => void }
      ).onClick(),
    );
    expect(scroller.scrollTop).toBe(1400);
  } finally {
    await act(() => renderer.unmount());
  }
});
