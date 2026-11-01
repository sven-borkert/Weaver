import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AutoApproveChanges } from "./AutoApproveChanges";

const mock = vi.hoisted(() => ({ pending: false, mutate: vi.fn() }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    assistant: {
      setAutoApproveChanges: {
        useMutation: () => ({ isPending: mock.pending, mutate: mock.mutate }),
      },
    },
  },
}));
beforeEach(() => {
  mock.pending = false;
  mock.mutate.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

it("explains the setting's conversation scope and disables the checkbox while saving", () => {
  mock.pending = true;
  const html = renderToStaticMarkup(
    <AutoApproveChanges conversationId="c1" enabled={false} />,
  );
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('disabled=""');
  expect(html).not.toContain('checked=""');
  expect(html).toContain(
    "New document, table and exam changes in the pinned project",
  );
  expect(html).toContain("other projects require review");
  expect(html).toContain(
    "Write tools of your MCP connections also run without asking",
  );
  expect(html).toContain("Saving");
});

it("sends the explicit checked value for the current conversation without optimistic approval", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <AutoApproveChanges conversationId="c1" enabled={false} />,
    );
  });
  try {
    const props = () =>
      renderer.root.findByType("input").props as {
        checked: boolean;
        onChange: (event: { target: { checked: boolean } }) => void;
      };
    await act(() => {
      props().onChange({ target: { checked: true } });
    });
    expect(mock.mutate).toHaveBeenCalledExactlyOnceWith({
      conversationId: "c1",
      enabled: true,
    });
    expect(props().checked).toBe(false);
    await act(() => {
      renderer.update(<AutoApproveChanges conversationId="c2" enabled />);
    });
    await act(() => {
      props().onChange({ target: { checked: false } });
    });
    expect(mock.mutate).toHaveBeenLastCalledWith({
      conversationId: "c2",
      enabled: false,
    });
  } finally {
    await act(() => renderer.unmount());
  }
});
