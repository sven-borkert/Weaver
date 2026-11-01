import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantConversation } from "./AssistantConversation";
const fixture = vi.hoisted(() => ({
  data: undefined as
    | { title: string; pinnedProjectId: null; messages: []; activeRun: null }
    | undefined,
  ref: { current: null as { focus: () => void } | null },
  consume: vi.fn(),
  effects: [] as Array<{ run: () => void; deps: unknown[] | undefined }>,
}));
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof React>("react")),
  useEffect: (run: () => void, deps?: unknown[]) => {
    fixture.effects.push({ run, deps });
  },
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      assistant: {
        getConversation: { invalidate: vi.fn() },
        listConversations: { invalidate: vi.fn() },
      },
    }),
    assistant: {
      getConversation: {
        useQuery: () => ({ data: fixture.data, error: null }),
      },
      getConversationUsage: { useQuery: () => ({ data: undefined }) },
      renameConversation: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));
vi.mock("./AssistantProvider", () => ({
  useAssistant: () => ({
    composerRef: fixture.ref,
    consumeComposerFocusRequest: fixture.consume,
  }),
}));
vi.mock("./useScopeDraft", () => ({
  useScopeDraft: () => ({
    draft: { kind: "all" },
    page: {},
    accessibleProjects: [],
    dropped: false,
    setDraft: vi.fn(),
  }),
}));
vi.mock("./Composer", () => ({
  Composer: () => <textarea aria-label="Message the assistant" />,
}));
vi.mock("./ConversationMenu", () => ({ ConversationMenu: () => null }));
vi.mock("./ScopeSelector", () => ({ ScopeSelector: () => null }));
vi.mock("./Transcript", () => ({ Transcript: () => null }));
vi.mock("./AutoApproveChanges", () => ({ AutoApproveChanges: () => null }));
const render = () =>
  renderToStaticMarkup(
    <AssistantConversation
      conversationId="new"
      onNew={() => undefined}
      onOpenList={() => undefined}
      onDeleted={() => undefined}
      onUnavailable={() => undefined}
      fullPage
    />,
  );
beforeEach(() => {
  fixture.data = undefined;
  fixture.ref.current = null;
  fixture.consume.mockReset().mockReturnValue(true);
  fixture.effects = [];
});
describe("new assistant composer focus", () => {
  it("keeps the focus request pending until conversation data and composer exist", () => {
    render();
    fixture.effects.forEach((effect) => effect.run());
    expect(fixture.consume).not.toHaveBeenCalled();
    const unloadedDeps = fixture.effects.at(-1)?.deps;
    fixture.effects = [];
    fixture.data = {
      title: "New conversation",
      pinnedProjectId: null,
      messages: [],
      activeRun: null,
    };
    const focus = vi.fn();
    fixture.ref.current = { focus };
    render();
    expect(fixture.effects.at(-1)?.deps).not.toEqual(unloadedDeps);
    fixture.effects.forEach((effect) => effect.run());
    expect(fixture.consume).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });
});
