import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocked = vi.hoisted(() => ({
  open: true,
  setOpen: vi.fn(),
}));

vi.mock("./AssistantProvider", () => ({
  useAssistant: () => ({
    open: mocked.open,
    setOpen: mocked.setOpen,
    composerRef: { current: null },
  }),
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? children : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <section role="dialog">{children}</section>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));

import { AssistantPanel } from "./AssistantPanel";

describe("AssistantPanel", () => {
  it("renders a dialog with background-run guidance", () => {
    mocked.open = true;
    const html = renderToStaticMarkup(
      <AssistantPanel returnFocusRef={{ current: null }}>
        <p>content</p>
      </AssistantPanel>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("content");
    expect(html).toContain("continue in the background");
    expect(html).not.toContain("<aside");
  });

  it("renders nothing while closed", () => {
    mocked.open = false;
    const html = renderToStaticMarkup(
      <AssistantPanel returnFocusRef={{ current: null }}>
        <p>content</p>
      </AssistantPanel>,
    );
    expect(html).toBe("");
  });
});
