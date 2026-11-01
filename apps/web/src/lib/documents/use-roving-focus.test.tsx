import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { useRovingFocus } from "./use-roving-focus";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type StubElement = { focus: ReturnType<typeof vi.fn> };
type SyntheticKeyDown = (event: unknown) => void;

function Harness({
  count,
  columns,
  onActivate,
  onNavigateUp,
  onReady,
}: {
  count: number;
  columns: number | (() => number);
  onActivate: (index: number) => void;
  onNavigateUp: () => void;
  onReady: (onKeyDown: SyntheticKeyDown) => void;
}) {
  const { onKeyDown, itemProps } = useRovingFocus({
    count,
    columns,
    onActivate,
    onNavigateUp,
  });
  // Hand the current render's closure back out on every render, since focusedIndex is captured by value.
  onReady(onKeyDown as unknown as SyntheticKeyDown);
  return (
    <div onKeyDown={onKeyDown}>
      {Array.from({ length: count }, (_, index) => {
        const { ref, ...rest } = itemProps(index);
        return <button key={index} ref={ref} data-index={index} {...rest} />;
      })}
    </div>
  );
}

async function mount(props: {
  count: number;
  columns: number | (() => number);
  onActivate: (index: number) => void;
  onNavigateUp: () => void;
}) {
  const items = new Map<number, StubElement>();
  // Reassigned by the Harness on every render; `press` below always reads the live value.
  let onKeyDown!: SyntheticKeyDown;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <Harness {...props} onReady={(handler) => (onKeyDown = handler)} />,
      {
        createNodeMock: (element) => {
          const index = (element.props as { "data-index"?: number })[
            "data-index"
          ];
          const stub: StubElement = { focus: vi.fn() };
          if (typeof index === "number") items.set(index, stub);
          return stub;
        },
      },
    );
  });
  const press = async (target: unknown, key: string, altKey = false) => {
    await act(async () => {
      onKeyDown({ key, altKey, target, preventDefault: vi.fn() });
    });
  };
  const tabIndexOf = (index: number) =>
    renderer.root.findAllByType("button")[index]!.props.tabIndex as number;
  return { items, press, tabIndexOf };
}

describe("useRovingFocus", () => {
  it("calls onActivate with the focused index on Enter", async () => {
    const onActivate = vi.fn();
    const { items, press } = await mount({
      count: 4,
      columns: 1,
      onActivate,
      onNavigateUp: vi.fn(),
    });
    await press(items.get(0), "ArrowDown");
    await press(items.get(1), "Enter");
    expect(onActivate).toHaveBeenCalledWith(1);
  });

  it("ignores a keydown whose target is not a registered item", async () => {
    const onActivate = vi.fn();
    const onNavigateUp = vi.fn();
    const { press } = await mount({
      count: 4,
      columns: 1,
      onActivate,
      onNavigateUp,
    });
    const foreignTarget = {};
    await press(foreignTarget, "Enter");
    await press(foreignTarget, "Backspace");
    expect(onActivate).not.toHaveBeenCalled();
    expect(onNavigateUp).not.toHaveBeenCalled();
  });

  it("moves focus down one item when columns is 1", async () => {
    const { items, press, tabIndexOf } = await mount({
      count: 4,
      columns: 1,
      onActivate: vi.fn(),
      onNavigateUp: vi.fn(),
    });
    expect(tabIndexOf(0)).toBe(0);
    expect(tabIndexOf(1)).toBe(-1);
    await press(items.get(0), "ArrowDown");
    expect(tabIndexOf(0)).toBe(-1);
    expect(tabIndexOf(1)).toBe(0);
  });

  it("moves focus by the column count in a grid", async () => {
    const { items, press, tabIndexOf } = await mount({
      count: 6,
      columns: 3,
      onActivate: vi.fn(),
      onNavigateUp: vi.fn(),
    });
    await press(items.get(0), "ArrowDown");
    expect(tabIndexOf(0)).toBe(-1);
    expect(tabIndexOf(3)).toBe(0);
  });

  it("clamps ArrowUp at the first item", async () => {
    const { items, press, tabIndexOf } = await mount({
      count: 4,
      columns: 1,
      onActivate: vi.fn(),
      onNavigateUp: vi.fn(),
    });
    await press(items.get(0), "ArrowUp");
    expect(tabIndexOf(0)).toBe(0);
  });

  it("Home and End jump to the first and last item", async () => {
    const { items, press, tabIndexOf } = await mount({
      count: 4,
      columns: 1,
      onActivate: vi.fn(),
      onNavigateUp: vi.fn(),
    });
    await press(items.get(0), "End");
    expect(tabIndexOf(3)).toBe(0);
    await press(items.get(3), "Home");
    expect(tabIndexOf(0)).toBe(0);
  });

  it("calls onNavigateUp on Backspace", async () => {
    const onNavigateUp = vi.fn();
    const { items, press } = await mount({
      count: 4,
      columns: 1,
      onActivate: vi.fn(),
      onNavigateUp,
    });
    await press(items.get(0), "Backspace");
    expect(onNavigateUp).toHaveBeenCalledTimes(1);
  });

  it("calls onNavigateUp on Alt+ArrowUp without moving focus", async () => {
    const onNavigateUp = vi.fn();
    const { items, press, tabIndexOf } = await mount({
      count: 4,
      columns: 1,
      onActivate: vi.fn(),
      onNavigateUp,
    });
    await press(items.get(0), "ArrowDown");
    expect(tabIndexOf(1)).toBe(0);
    await press(items.get(1), "ArrowUp", /* altKey */ true);
    expect(onNavigateUp).toHaveBeenCalledTimes(1);
    expect(tabIndexOf(1)).toBe(0);
  });

  it("resolves columns as a function on each keydown", async () => {
    const columns = vi.fn(() => 1);
    const { items, press } = await mount({
      count: 4,
      columns,
      onActivate: vi.fn(),
      onNavigateUp: vi.fn(),
    });
    columns.mockClear();
    await press(items.get(0), "ArrowDown");
    expect(columns).toHaveBeenCalled();
  });
});
