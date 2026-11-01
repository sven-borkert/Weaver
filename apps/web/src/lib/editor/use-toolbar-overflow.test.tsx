import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToolbarOverflow } from "./use-toolbar-overflow";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MORE_WIDTH = 34;
let tree: ReactTestRenderer | undefined;
let rowWidth = 124;
let rights: number[] = [];
let moreShown = false;
let observers: FakeObserver[] = [];

class FakeObserver {
  targets: object[] = [];
  constructor(
    readonly callback: (
      entries: { target: object; contentRect: { width: number } }[],
    ) => void,
  ) {
    observers.push(this);
  }
  observe(target: object) {
    this.targets.push(target);
  }
  disconnect() {
    observers = observers.filter((observer) => observer !== this);
  }
}

// Groups keep their box when hidden; More takes its width from the row.
const row = {
  get clientWidth() {
    return rowWidth - (moreShown ? MORE_WIDTH : 0);
  },
  querySelectorAll: () =>
    rights.map((right) => ({
      offsetTop: 0,
      offsetLeft: right - 10,
      offsetWidth: 10,
    })),
};

// Refs attach before the hook's layout effect measures, like a real More button.
const trackMore = (node: unknown) => {
  moreShown = node !== null;
};

function Probe({ groupKey }: { groupKey: string }) {
  const { rowRef, visible } = useToolbarOverflow(groupKey);
  return (
    <>
      <div ref={rowRef} data-visible={visible} />
      {visible < rights.length ? <button ref={trackMore} /> : null}
    </>
  );
}

function visible() {
  return tree!.root.findByType("div").props["data-visible"] as number;
}

async function render(groupKey: string) {
  await act(() => {
    if (tree) tree.update(<Probe groupKey={groupKey} />);
    else
      tree = create(<Probe groupKey={groupKey} />, {
        createNodeMock: () => row,
      });
  });
}

async function resizeRow(width: number) {
  const previous = row.clientWidth;
  rowWidth = width;
  await act(() => {
    for (const observer of observers) {
      observer.callback([{ target: row, contentRect: { width: previous } }]);
      observer.callback([
        { target: row, contentRect: { width: row.clientWidth } },
      ]);
    }
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeObserver);
  rowWidth = 124;
  moreShown = false;
});
afterEach(async () => {
  await act(() => tree?.unmount());
  tree = undefined;
  observers = [];
  vi.unstubAllGlobals();
});

describe("useToolbarOverflow", () => {
  it("treats every group as fitting without ResizeObserver", async () => {
    vi.unstubAllGlobals();
    rights = [40, 200];
    await render("a");
    expect(visible()).toBe(Number.POSITIVE_INFINITY);
  });

  it("measures new groups from the full row instead of a stale count", async () => {
    rights = [40, 80, 110];
    await render("a");
    expect(visible()).toBe(3);
    rights = [40, 80, 110, 122];
    await render("b");
    expect(visible()).toBe(4);
    expect(moreShown).toBe(false);
  });

  it("hides groups when the row narrows and restores them when it widens", async () => {
    rights = [40, 80, 110, 122];
    await render("a");
    expect(visible()).toBe(4);
    await resizeRow(115);
    expect(visible()).toBe(3);
    await resizeRow(115);
    expect(visible()).toBe(2);
    // The groups fit only once More is gone, so a wider row re-measures without it.
    await resizeRow(130);
    expect(visible()).toBe(4);
    expect(moreShown).toBe(false);
  });
});
