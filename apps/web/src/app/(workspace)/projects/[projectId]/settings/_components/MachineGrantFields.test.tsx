import { useState, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GrantInput } from "@weaver/core/projectApi/schemas";

const mocks = vi.hoisted(() => ({
  pages: [] as { items: Record<string, unknown>[]; nextCursor: null }[],
  queryInput: undefined as Record<string, unknown> | undefined,
}));

vi.mock("~/trpc/react", () => ({
  api: {
    projectApiKey: {
      targets: {
        useInfiniteQuery: (input: Record<string, unknown>) => {
          mocks.queryInput = input;
          return {
            data: { pages: mocks.pages },
            error: null,
            isLoading: false,
            hasNextPage: false,
            isFetchingNextPage: false,
            refetch: vi.fn(),
            fetchNextPage: vi.fn(),
          };
        },
      },
    },
  },
}));
vi.mock("~/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import {
  MachineGrantFields,
  grantIdentity,
  type GrantTargetDisplay,
} from "./MachineGrantFields";

const docA = "11111111-1111-4111-8111-111111111111";
const docB = "22222222-2222-4222-8222-222222222222";
const missing = "33333333-3333-4333-8333-333333333333";

const record = vi.fn<(value: GrantInput[]) => void>();
const latest = () => record.mock.lastCall?.[0] ?? [];
function Harness({
  initial,
  known = new Map(),
  disabled = false,
}: {
  initial: GrantInput[];
  known?: ReadonlyMap<string, GrantTargetDisplay>;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MachineGrantFields
      projectId="project"
      value={value}
      onChange={(next) => {
        record(next);
        setValue(next);
      }}
      disabled={disabled}
      known={known}
      invalidGrants={new Set()}
    />
  );
}

async function mount(element: ReactNode) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<>{element}</>);
  });
  return renderer;
}
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
type Node = ReactTestRenderer["root"];
const textOf = (node: Node | string): string =>
  typeof node === "string"
    ? node
    : node.children.map((child) => textOf(child)).join("");
const fire = (handler: unknown) => (handler as () => void)();
const checkbox = (renderer: ReactTestRenderer, label: string) =>
  renderer.root
    .findAllByType("label")
    .find((l) => textOf(l).includes(label))!
    .findByType("input");

describe("machine grant fields", () => {
  beforeEach(() => {
    record.mockClear();
    mocks.pages = [
      {
        items: [
          {
            kind: "document",
            targetId: docA,
            label: "Latest audit",
            location: "audit/latest.md",
          },
          {
            kind: "document",
            targetId: docB,
            label: "Weekly audit",
            location: "audit/weekly.md",
          },
        ],
        nextCursor: null,
      },
    ];
  });

  it("expands several selected targets into individual grants with no actions preselected", async () => {
    const renderer = await mount(<Harness initial={[]} />);
    await act(async () =>
      fire(checkbox(renderer, "Latest audit").props.onChange),
    );
    await act(async () =>
      fire(checkbox(renderer, "Weekly audit").props.onChange),
    );
    expect(latest()).toEqual([
      { kind: "document", targetId: docA, actions: [] },
      { kind: "document", targetId: docB, actions: [] },
    ]);
    const actions = renderer.root
      .findAllByType("li")[0]!
      .findAllByType("label")
      .map((l) => textOf(l));
    expect(actions.join()).toContain("Read");
    expect(actions.join()).toContain("Update");
    expect(actions.join()).not.toContain("Create");
    await act(async () =>
      fire(
        renderer.root.findAllByType("li")[0]!.findAllByType("input").at(-1)!
          .props.onChange,
      ),
    );
    expect(latest()[0]!.actions).toEqual(["delete"]);
  });

  it("names root scopes and states that folders include future content", async () => {
    mocks.pages = [
      {
        items: [
          {
            kind: "documentFolder",
            root: true,
            label: "Documents root",
            location: "",
          },
          {
            kind: "documentFolder",
            targetId: docA,
            label: "audit",
            location: "audit",
          },
        ],
        nextCursor: null,
      },
    ];
    const renderer = await mount(
      <Harness
        initial={[
          { kind: "documentFolder", root: true, actions: ["create"] },
          { kind: "documentFolder", targetId: docA, actions: ["create"] },
        ]}
      />,
    );
    const html = text(renderer);
    expect(html).toContain("All documents (documents root)");
    expect(html).toContain("includes subfolders and future content");
    expect(mocks.queryInput).toMatchObject({ kind: "documentFolder" });
  });

  it("keeps an unavailable target as its identity rather than a root grant", async () => {
    const grant: GrantInput = {
      kind: "document",
      targetId: missing,
      actions: ["update"],
    };
    const renderer = await mount(
      <Harness
        initial={[grant]}
        known={
          new Map([
            [
              grantIdentity(grant),
              { label: "Unavailable target", location: "", available: false },
            ],
          ])
        }
      />,
    );
    expect(text(renderer)).toContain("grants nothing until this exact item");
    await act(async () =>
      fire(
        renderer.root.findAllByType("li")[0]!.findAllByType("input")[0]!.props
          .onChange,
      ),
    );
    expect(latest()).toEqual([
      { kind: "document", targetId: missing, actions: ["read", "update"] },
    ]);
  });

  it("disables the whole picker while pending", async () => {
    const renderer = await mount(<Harness initial={[]} disabled />);
    expect(renderer.root.findByType("fieldset").props.disabled).toBe(true);
    expect(checkbox(renderer, "Latest audit").props.disabled).toBe(true);
  });
});
