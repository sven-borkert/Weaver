import { renderToStaticMarkup } from "react-dom/server";
import { createRef } from "react";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ apiKey: { list: { invalidate: vi.fn() } } }),
    apiKey: {
      update: {
        useMutation: () => ({ isPending: false, mutate: mocked.mutate }),
      },
    },
  },
}));

import { EditApiKeyDialog } from "./EditApiKeyDialog";

const apiKey = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Claude Code",
  start: "wvr_abcd",
  capabilities: ["mcp:use", "content:read", "content:write", "system:admin"],
  projectIds: ["22222222-2222-4222-8222-222222222222"],
  expiresAt: null,
  lastUsedAt: null,
  rateLimitPerMinute: 120,
  enabled: true,
} as const;

const projects = [
  { id: "22222222-2222-4222-8222-222222222222", name: "Restricted" },
  { id: "33333333-3333-4333-8333-333333333333", name: "Open" },
] as never;

const render = (isAdmin: boolean) =>
  renderToStaticMarkup(
    <EditApiKeyDialog
      apiKey={apiKey as never}
      isAdmin={isAdmin}
      projects={projects}
      fallbackFocusRef={createRef<HTMLElement>()}
    />,
  );

describe("EditApiKeyDialog", () => {
  it("renders an edit trigger and a form with the policy fields for the listed key", () => {
    // react-hook-form applies register() defaults after mount, so static
    // markup shows structure only; Controller-backed fields carry state.
    const html = render(true);
    expect(html).toContain('aria-label="Edit Claude Code"');
    expect(html).toContain(
      'id="edit-api-key-11111111-1111-4111-8111-111111111111-name"',
    );
    expect(html).toContain('name="write"');
    expect(html).toContain('name="admin"');
    expect(html).toContain('name="ingest"');
    expect(html).toContain("Requests per minute");
    expect(html).not.toContain("Expires");
    expect(html).toMatch(/checked=""[^>]*\/>Restricted/);
    expect(html).not.toMatch(/checked=""[^>]*\/>Open/);
  });

  it("warns a non-Admin that saving drops the dormant admin grant", () => {
    const html = render(false);
    expect(html).not.toContain("System administration");
    expect(html).toContain(
      "Saving removes the inactive system administration grant",
    );
    expect(render(true)).not.toContain("Saving removes the inactive");
  });
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const A = "44444444-4444-4444-8444-444444444444";
const B = "33333333-3333-4333-8333-333333333333";

async function mount(projectIds: string[], memberOf: { id: string }[]) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <EditApiKeyDialog
        apiKey={{ ...apiKey, projectIds } as never}
        isAdmin
        projects={memberOf.map((p) => ({ ...p, name: "Open" })) as never}
        fallbackFocusRef={createRef<HTMLElement>()}
      />,
      {
        createNodeMock: (element) => {
          const props = element.props as { name?: string; type?: string };
          return {
            name: props.name ?? "",
            type: props.type ?? "text",
            value: "",
            checked: false,
            focus: vi.fn(),
            select: vi.fn(),
          };
        },
      },
    );
  });
  return renderer;
}

const unavailableBoxes = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAllByType("label")
    .filter((label) =>
      (label.props.children as unknown[]).includes("Unavailable project"),
    )
    .map((label) => label.findByType("input"));

async function submit(renderer: ReactTestRenderer) {
  const onSubmit = renderer.root.findByType("form").props.onSubmit as (event: {
    preventDefault(): void;
    persist(): void;
  }) => Promise<void> | void;
  await act(async () => {
    await onSubmit({ preventDefault: vi.fn(), persist: vi.fn() });
  });
  return (
    mocked.mutate.mock.calls.at(-1)?.[0] as { projectIds: string[] } | undefined
  )?.projectIds;
}

describe("EditApiKeyDialog unavailable project restrictions", () => {
  beforeEach(() => mocked.mutate.mockReset());

  it("lists a lost project as removable and submits the rest once it is unchecked", async () => {
    const renderer = await mount([A, B], [{ id: B }]);
    const [box, ...rest] = unavailableBoxes(renderer);
    expect(rest).toHaveLength(0);
    expect(box!.props.checked).toBe(true);

    await act(async () => {
      (box!.props.onChange as () => void)();
    });

    expect(unavailableBoxes(renderer)).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("reaches all");
    expect(await submit(renderer)).toEqual([B]);
  });

  it("keeps a sole unavailable restriction until the user removes it", async () => {
    const renderer = await mount([A], []);
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "You are not a member of any project.",
    );
    expect(unavailableBoxes(renderer)).toHaveLength(1);
    expect(await submit(renderer)).toEqual([A]);

    await act(async () => {
      (unavailableBoxes(renderer)[0]!.props.onChange as () => void)();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain("this key reaches all");
    expect(await submit(renderer)).toEqual([]);
  });
});
