import { useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AvailableExternalTool,
  ExternalInput,
} from "@weaver/core/externalMcp/types";
import type { ScopeRequest } from "@weaver/core/assistant/scopeSchema";
const mocked = vi.hoisted(() => ({
  tools: [] as AvailableExternalTool[],
  outputTools: undefined as AvailableExternalTool[] | undefined,
  error: false,
  fetching: false,
  queries: [] as unknown[],
}));
vi.mock("~/trpc/react", () => ({
  api: {
    externalMcp: {
      availability: {
        useQuery: (input: { scope: ScopeRequest }) => {
          mocked.queries.push(input);
          return {
            data: {
              tools:
                input.scope.kind === "project" &&
                input.scope.projectId === "output"
                  ? (mocked.outputTools ?? mocked.tools)
                  : mocked.tools,
              connections: [{ id: "c", name: "Analytics" }],
            },
            error: mocked.error ? new Error("Unavailable") : null,
            isFetching: mocked.fetching,
            refetch: vi.fn(),
          };
        },
      },
    },
  },
}));
import {
  ExternalInputsEditor,
  ExternalInputsList,
} from "./ExternalInputsEditor";
import { ExternalInputRunSummary } from "./RunHistoryTable";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const tool: AvailableExternalTool = {
  id: "11111111-1111-4111-8111-111111111111",
  connectionId: "c",
  name: "counts",
  description: "Read counts",
  effect: "read",
  inputSchema: { type: "object", properties: { hours: { type: "number" } } },
  configRevision: 1,
  reviewDigest: "digest",
};
const input: ExternalInput = {
  name: "Daily counts",
  toolId: tool.id,
  arguments: { hours: { kind: "literal", value: 24 } },
};
let current: ExternalInput[] = [];
function Harness({
  scope = { kind: "project", projectId: "source" },
  outputProjectId = "output",
  initial = [],
}: {
  scope?: ScopeRequest;
  outputProjectId?: string;
  initial?: ExternalInput[];
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    current = value;
  }, [value]);
  return (
    <ExternalInputsEditor
      scope={scope}
      outputProjectId={outputProjectId}
      value={value}
      onChange={setValue}
    />
  );
}
function button(r: ReactTestRenderer, text: string) {
  return r.root
    .findAllByType("button")
    .find(
      (node) =>
        node.children.filter((child) => typeof child === "string").join("") ===
        text,
    )!;
}
beforeEach(() => {
  mocked.tools = [tool];
  mocked.outputTools = undefined;
  mocked.error = false;
  mocked.fetching = false;
  mocked.queries = [];
  current = [];
});
describe("scheduled external-input editor", () => {
  it("renders legacy empty and unavailable saved inputs without removing them", () => {
    mocked.error = true;
    expect(renderToStaticMarkup(<Harness />)).toContain(
      "still save a task without external inputs",
    );
    const html = renderToStaticMarkup(<Harness initial={[input]} />);
    expect(html).toContain("Daily counts");
    expect(html).toContain("saved input is retained");
    expect(html).toContain("Remove input");
  });
  it("never offers writes", () => {
    mocked.tools = [{ ...tool, id: "write", effect: "write" }];
    const html = renderToStaticMarkup(<Harness />);
    expect(html).toContain("No eligible read tools");
    expect(html).toContain("disabled");
  });
  it("drives add, literal errors, period replacement, ordering and removal through mounted callbacks", async () => {
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<Harness />);
    });
    await act(async () => {
      (button(r, "Add external input").props.onClick as () => void)();
    });
    expect(current).toHaveLength(1);
    const validity = vi.fn();
    await act(async () => {
      (
        r.root.findByProps({ "aria-label": "Input 1 JSON arguments" }).props
          .onChange as (event: {
          target: {
            value: string;
            setCustomValidity?: (message: string) => void;
          };
        }) => void
      )({
        target: { value: '{"hours":24}', setCustomValidity: validity },
      });
    });
    expect(current[0]!.arguments.hours).toEqual({ kind: "literal", value: 24 });
    await act(async () => {
      (
        r.root.findByProps({ "aria-label": "Input 1 JSON arguments" }).props
          .onChange as (event: {
          target: {
            value: string;
            setCustomValidity?: (message: string) => void;
          };
        }) => void
      )({
        target: { value: "[]", setCustomValidity: validity },
      });
    });
    expect(validity).toHaveBeenLastCalledWith(
      expect.stringContaining("valid JSON object"),
    );
    expect(current[0]!.arguments.hours).toEqual({ kind: "literal", value: 24 });
    expect(r.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    await act(async () => {
      (
        r.root.findByProps({ "aria-label": "Input 1 JSON arguments" }).props
          .onChange as (event: {
          target: {
            value: string;
            setCustomValidity?: (message: string) => void;
          };
        }) => void
      )({
        target: { value: '{"hours":24}', setCustomValidity: validity },
      });
    });
    await act(async () => {
      (
        r.root.findByProps({ "aria-label": "Input 1 period property" }).props
          .onChange as (event: {
          target: {
            value: string;
            setCustomValidity?: (message: string) => void;
          };
        }) => void
      )({ target: { value: "hours" } });
    });
    await act(async () => {
      (button(r, "Bind period_start").props.onClick as () => void)();
    });
    expect(current[0]!.arguments.hours).toEqual({ kind: "period_start" });
    for (let i = 0; i < 4; i++)
      await act(async () => {
        (button(r, "Add external input").props.onClick as () => void)();
      });
    expect(current).toHaveLength(5);
    expect(button(r, "Add external input").props.disabled).toBe(true);
    await act(async () => {
      (button(r, "Move input 1 down").props.onClick as () => void)();
    });
    expect(current[1]!.arguments.hours).toEqual({ kind: "period_start" });
    await act(async () => {
      (button(r, "Remove input 2").props.onClick as () => void)();
    });
    expect(current).toHaveLength(4);
    expect(current.some((value) => "hours" in value.arguments)).toBe(false);
    await act(async () => {
      r.unmount();
    });
  });
  it("rekeys source/output queries and retains unavailable definitions on scope and policy changes", async () => {
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<Harness initial={[input]} />);
    });
    mocked.outputTools = [];
    await act(async () => {
      r.update(
        <Harness
          initial={[input]}
          scope={{ kind: "projects", projectIds: ["changed"] }}
        />,
      );
    });
    expect(mocked.queries).toContainEqual({
      scope: { kind: "projects", projectIds: ["changed"] },
    });
    expect(current).toEqual([input]);
    expect(button(r, "Add external input").props.disabled).toBe(true);
    mocked.tools = [{ ...tool, id: "write", effect: "write" }];
    await act(async () => {
      r.update(<Harness initial={[input]} outputProjectId="changed-output" />);
    });
    expect(mocked.queries).toContainEqual({
      scope: { kind: "project", projectId: "changed-output" },
    });
    expect(current).toEqual([input]);
    expect(button(r, "Add external input").props.disabled).toBe(true);
    await act(async () => {
      r.unmount();
    });
  });
  it("renders read-only definitions and only safe run outcome metadata", () => {
    const html = renderToStaticMarkup(<ExternalInputsList value={[input]} />);
    expect(html).toContain("Daily counts");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("<input");
    const summary = renderToStaticMarkup(
      <ExternalInputRunSummary
        context={{
          externalInputs: [
            {
              name: "Counts",
              status: "failed",
              retrievedAt: "2026-09-09T10:00:00Z",
              truncated: true,
              errorCode: "EXTERNAL_APPROVAL_REQUIRED",
              output: "PRIVATE_RESULT",
              token: "PRIVATE_TOKEN",
            },
          ],
        }}
      />,
    );
    expect(summary).toContain("Failed");
    expect(summary).toContain("Retrieved:");
    expect(summary).toContain("Yes");
    expect(summary).toContain("asked before every call");
    expect(summary).not.toContain("PRIVATE_");
  });
});
