import { createProgrammaticNavigationGuard } from "./use-unsaved-changes-guard";
import { describe, expect, it, vi } from "vitest";

import {
  createHistoryPopstateGuard,
  historyStateWithPoint,
  installHistoryStateTracker,
  shouldBlockUrl,
  shouldProceedWithNavigation,
  shouldPromptBeforeUnload,
  suppressUnsavedPrompt,
  type HistoryPopstate,
  type HistoryTrackerHost,
} from "./use-unsaved-changes-guard";

const currentState = {
  __NA: true,
  __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ["current"] },
  custom: "kept",
};

describe("shouldBlockUrl", () => {
  it("blocks dirty same-origin navigation to a different URL", () => {
    expect(
      shouldBlockUrl(true, "https://weaver.local/a", "https://weaver.local/b"),
    ).toBe(true);
  });

  it("allows navigation when there are no unsaved changes", () => {
    expect(
      shouldBlockUrl(false, "https://weaver.local/a", "https://weaver.local/b"),
    ).toBe(false);
  });

  it("allows dirty navigation to another origin", () => {
    expect(
      shouldBlockUrl(true, "https://weaver.local/a", "https://outside.test/b"),
    ).toBe(false);
  });

  it("allows dirty navigation to the current URL", () => {
    expect(
      shouldBlockUrl(true, "https://weaver.local/a", "https://weaver.local/a"),
    ).toBe(false);
  });

  it("resolves relative targets against the current URL", () => {
    expect(
      shouldBlockUrl(true, "https://weaver.local/a", "/documents/next"),
    ).toBe(true);
  });
});

describe("shouldProceedWithNavigation", () => {
  it("does not ask for confirmation when there are no unsaved changes", () => {
    let confirmations = 0;

    expect(
      shouldProceedWithNavigation(false, () => {
        confirmations += 1;
        return false;
      }),
    ).toBe(true);
    expect(confirmations).toBe(0);
  });

  it("blocks dirty navigation when discard is declined", () => {
    expect(shouldProceedWithNavigation(true, () => false)).toBe(false);
  });

  it("allows dirty navigation when discard is confirmed", () => {
    expect(shouldProceedWithNavigation(true, () => true)).toBe(true);
  });
});

describe("history state tracking", () => {
  const currentSnapshot = {
    currentPoint: 5,
    sessionId: "session-a",
    navigationIndex: 10,
    currentUrl: "https://weaver.local/documents/current",
    currentState,
  };

  it("adds a session point without dropping complete Next history state", () => {
    expect(historyStateWithPoint(currentState, 7, "session-a")).toEqual({
      __NA: true,
      __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ["current"] },
      custom: "kept",
      __weaverHistoryPoint: { point: 7, sessionId: "session-a" },
    });
  });

  it("reads dirty state at traversal time instead of capturing the install-time value", () => {
    let dirty = false;
    let confirmations = 0;
    const traversals: number[] = [];
    const guard = createHistoryPopstateGuard({
      getCurrentSnapshot: () => currentSnapshot,
      isDirty: () => dirty,
      confirmDiscard: () => {
        confirmations += 1;
        return false;
      },
      go: (delta) => traversals.push(delta),
      restoreCurrentEntry: () => undefined,
    });
    dirty = true;

    guard({
      targetUrl: "https://weaver.local/documents/previous",
      targetNavigationIndex: 9,
      state: { __NA: true },
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    });

    expect(confirmations).toBe(1);
    expect(traversals).toEqual([1]);
  });

  it.each([
    { name: "Back", targetIndex: 9, restorationDelta: 1 },
    { name: "Forward", targetIndex: 11, restorationDelta: -1 },
    { name: "multi-entry", targetIndex: 4, restorationDelta: 6 },
  ])(
    "uses the native index for cancelled unmarked $name traversal",
    ({ targetIndex, restorationDelta }) => {
      const traversals: number[] = [];
      const restored: unknown[] = [];
      const guard = createHistoryPopstateGuard({
        getCurrentSnapshot: () => currentSnapshot,
        isDirty: () => true,
        confirmDiscard: () => false,
        go: (delta) => traversals.push(delta),
        restoreCurrentEntry: (snapshot) => restored.push(snapshot),
      });
      let stopped = false;

      guard({
        targetUrl: "https://weaver.local/documents/target",
        targetNavigationIndex: targetIndex,
        state: { __NA: true },
        preventDefault: () => undefined,
        stopImmediatePropagation: () => {
          stopped = true;
        },
      });

      expect(stopped).toBe(true);
      expect(traversals).toEqual([restorationDelta]);
      expect(restored).toEqual([]);
    },
  );

  it("restores the stored URL and complete Next state when an unmarked target has no native index", () => {
    const traversals: number[] = [];
    const restored: unknown[] = [];
    const fallbackSnapshot = {
      ...currentSnapshot,
      navigationIndex: null,
    };
    const guard = createHistoryPopstateGuard({
      getCurrentSnapshot: () => fallbackSnapshot,
      isDirty: () => true,
      confirmDiscard: () => false,
      go: (delta) => traversals.push(delta),
      restoreCurrentEntry: (snapshot) => restored.push(snapshot),
    });

    guard({
      targetUrl: "https://weaver.local/documents/unknown",
      targetNavigationIndex: null,
      state: { __NA: true, legacy: "target" },
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    });

    expect(traversals).toEqual([]);
    expect(restored).toEqual([fallbackSnapshot]);
  });

  it("uses same-session points when the native index is unavailable", () => {
    const traversals: number[] = [];
    const guard = createHistoryPopstateGuard({
      getCurrentSnapshot: () => ({
        ...currentSnapshot,
        navigationIndex: null,
      }),
      isDirty: () => true,
      confirmDiscard: () => false,
      go: (delta) => traversals.push(delta),
      restoreCurrentEntry: () => undefined,
    });

    guard({
      targetUrl: "https://weaver.local/documents/previous",
      targetNavigationIndex: null,
      state: {
        __NA: true,
        __weaverHistoryPoint: {
          point: 2,
          sessionId: currentSnapshot.sessionId,
        },
      },
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    });

    expect(traversals).toEqual([3]);
  });

  it("lets confirmed dirty history navigation reach Next", () => {
    const traversals: number[] = [];
    let prevented = false;
    const guard = createHistoryPopstateGuard({
      getCurrentSnapshot: () => currentSnapshot,
      isDirty: () => true,
      confirmDiscard: () => true,
      go: (delta) => traversals.push(delta),
      restoreCurrentEntry: () => undefined,
    });

    guard({
      targetUrl: "https://weaver.local/documents/previous",
      targetNavigationIndex: 9,
      state: { __NA: true },
      preventDefault: () => {
        prevented = true;
      },
      stopImmediatePropagation: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(false);
    expect(traversals).toEqual([]);
  });
});

describe("history tracker installation", () => {
  function createRuntime(options?: { navigationIndex?: number | null }) {
    let url = "https://weaver.local/current";
    let navigationIndex: number | null =
      options?.navigationIndex === undefined ? 3 : options.navigationIndex;
    let throwNextPush = false;
    const writes: Array<{
      kind: "push" | "replace";
      state: unknown;
      url: string | URL | null | undefined;
    }> = [];
    const popstateListeners: Array<(event: HistoryPopstate) => void> = [];
    const history = {
      state: currentState as unknown,
      pushState(
        state: unknown,
        _unused: string,
        nextUrl?: string | URL | null,
      ) {
        if (throwNextPush) {
          throwNextPush = false;
          throw new Error("push failed");
        }
        this.state = state;
        if (nextUrl) url = new URL(nextUrl, url).href;
        if (navigationIndex !== null) navigationIndex += 1;
        writes.push({ kind: "push", state, url: nextUrl });
      },
      replaceState(
        state: unknown,
        _unused: string,
        nextUrl?: string | URL | null,
      ) {
        this.state = state;
        if (nextUrl) url = new URL(nextUrl, url).href;
        writes.push({ kind: "replace", state, url: nextUrl });
      },
    };
    let session = 0;
    return {
      history,
      writes,
      runtime: {
        history,
        getUrl: () => url,
        getNavigationIndex: () => navigationIndex,
        createSessionId: () => `session-${++session}`,
        addPopstateListener: (listener: (event: HistoryPopstate) => void) =>
          popstateListeners.push(listener),
      },
      throwOnNextPush: () => {
        throwNextPush = true;
      },
      dispatchPopstate: (
        state: unknown,
        index: number | null,
        nextUrl = url,
      ) => {
        history.state = state;
        navigationIndex = index;
        url = nextUrl;
        let stopped = false;
        const event = {
          state,
          preventDefault: () => undefined,
          stopImmediatePropagation: () => {
            stopped = true;
          },
        };
        for (const listener of popstateListeners) {
          if (stopped) break;
          listener(event);
        }
      },
      addSimulatedNextListener: (listener: () => void) =>
        popstateListeners.push(listener),
      listenerCount: () => popstateListeners.length,
    };
  }

  it("wraps push and replace while preserving complete Next state", () => {
    const { history, runtime, writes } = createRuntime();
    const tracker = installHistoryStateTracker({}, runtime);
    writes.length = 0;

    history.pushState(currentState, "", "/pushed");
    history.replaceState(currentState, "", "/replaced");

    expect(writes).toEqual([
      {
        kind: "push",
        state: {
          ...currentState,
          __weaverHistoryPoint: { point: 4, sessionId: tracker.sessionId },
        },
        url: "/pushed",
      },
      {
        kind: "replace",
        state: {
          ...currentState,
          __weaverHistoryPoint: { point: 4, sessionId: tracker.sessionId },
        },
        url: "/replaced",
      },
    ]);
    expect(tracker.currentPoint).toBe(4);
    expect(tracker.currentUrl).toBe("https://weaver.local/replaced");
  });

  it("advances the point only after the underlying push succeeds", () => {
    const { history, runtime, throwOnNextPush, writes } = createRuntime();
    const tracker = installHistoryStateTracker({}, runtime);
    writes.length = 0;
    throwOnNextPush();

    expect(() => history.pushState(currentState, "", "/failed")).toThrow(
      "push failed",
    );
    expect(tracker.currentPoint).toBe(3);

    history.pushState(currentState, "", "/succeeds");
    expect(writes[0]!.state).toEqual({
      ...currentState,
      __weaverHistoryPoint: { point: 4, sessionId: tracker.sessionId },
    });
    expect(tracker.currentPoint).toBe(4);
  });

  it("starts a new marker session for accepted unmarked traversal without a native index", () => {
    const { runtime, dispatchPopstate, writes } = createRuntime({
      navigationIndex: null,
    });
    const tracker = installHistoryStateTracker({}, runtime);
    const originalSession = tracker.sessionId;
    writes.length = 0;

    dispatchPopstate({ __NA: true, legacy: "target" }, null);

    expect(tracker.sessionId).not.toBe(originalSession);
    expect(tracker.currentPoint).toBe(0);
    expect(writes).toEqual([
      {
        kind: "replace",
        state: {
          __NA: true,
          legacy: "target",
          __weaverHistoryPoint: {
            point: 0,
            sessionId: tracker.sessionId,
          },
        },
        url: "https://weaver.local/current",
      },
    ]);
  });

  it.each([2, 4, 8])(
    "adopts native index %s for accepted unmarked traversal",
    (targetIndex) => {
      const { runtime, dispatchPopstate, writes } = createRuntime();
      const tracker = installHistoryStateTracker({}, runtime);
      const sessionId = tracker.sessionId;
      writes.length = 0;

      dispatchPopstate({ __NA: true, legacy: "target" }, targetIndex);

      expect(tracker.sessionId).toBe(sessionId);
      expect(tracker.currentPoint).toBe(targetIndex);
      expect(writes[0]!.state).toEqual({
        __NA: true,
        legacy: "target",
        __weaverHistoryPoint: { point: targetIndex, sessionId },
      });
    },
  );

  it("is idempotent across repeated installation and HMR-style calls", () => {
    const { history, runtime, writes, listenerCount } = createRuntime();
    const host = {};
    const first = installHistoryStateTracker(host, runtime);
    const writesAfterFirstInstall = writes.length;
    const second = installHistoryStateTracker(host, runtime);

    expect(second).toBe(first);
    expect(writes).toHaveLength(writesAfterFirstInstall);
    expect(listenerCount()).toBe(1);

    writes.length = 0;
    history.pushState(currentState, "", "/once");
    expect(writes).toHaveLength(1);
  });

  it("runs a registered guard before mutating the tracker or notifying Next", () => {
    const host: HistoryTrackerHost = {};
    const { runtime, dispatchPopstate, addSimulatedNextListener, writes } =
      createRuntime();
    const tracker = installHistoryStateTracker(host, runtime);
    writes.length = 0;
    const calls: string[] = [];
    host.__weaverHistoryPopstateGuard = createHistoryPopstateGuard({
      getCurrentSnapshot: () => tracker,
      isDirty: () => true,
      confirmDiscard: () => {
        calls.push("guard");
        return false;
      },
      go: () => undefined,
      restoreCurrentEntry: () => undefined,
    });
    addSimulatedNextListener(() => calls.push("next"));

    dispatchPopstate(
      { __NA: true },
      2,
      "https://weaver.local/documents/previous",
    );

    expect(calls).toEqual(["guard"]);
    expect(tracker.currentUrl).toBe("https://weaver.local/current");
    expect(tracker.navigationIndex).toBe(3);
    expect(writes).toEqual([]);
  });
});

describe("programmatic navigation", () => {
  it.each(["document", "table"])(
    "asks before discarding a dirty %s from a search selection",
    () => {
      const confirmDiscard = vi.fn(() => false);
      const guard = createProgrammaticNavigationGuard({
        isDirty: () => true,
        currentUrl: () => "https://weaver.test/current",
        confirmDiscard,
      });
      expect(guard("/destination")).toBe(false);
      expect(confirmDiscard).toHaveBeenCalledOnce();
      expect(guard("/current")).toBe(true);
    },
  );
});

describe("beforeunload prompt suppression", () => {
  it("prompts only for dirty drafts", () => {
    expect(shouldPromptBeforeUnload(true)).toBe(true);
    expect(shouldPromptBeforeUnload(false)).toBe(false);
  });

  it("silences every dirty guard after a confirmed exit until it is restored", () => {
    const restore = suppressUnsavedPrompt();
    expect(shouldPromptBeforeUnload(true)).toBe(false);
    expect(shouldPromptBeforeUnload(true)).toBe(false);
    restore();
    expect(shouldPromptBeforeUnload(true)).toBe(true);
  });
});
