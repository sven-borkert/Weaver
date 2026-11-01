"use client";

import { useEffect, useEffectEvent, useLayoutEffect } from "react";

export const UNSAVED_CHANGES_CONFIRMATION = "Discard unsaved changes?";
const HISTORY_POINT_KEY = "__weaverHistoryPoint";

type HistoryState = Record<string, unknown> | null | undefined;

export type HistorySnapshot = {
  currentPoint: number;
  sessionId: string;
  navigationIndex: number | null;
  currentUrl: string;
  currentState: unknown;
};

export type HistoryTrackerHost = {
  __weaverHistoryTracker?: HistoryTracker;
  __weaverNavigationGuard?: (href: string) => boolean;
  __weaverHistoryPopstateGuard?: (event: GuardedPopstate) => boolean;
};

type HistoryTracker = HistorySnapshot;

type HistoryLike = {
  state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
};

export type HistoryPopstate = {
  state: unknown;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
};

export type HistoryTrackerRuntime = {
  history: HistoryLike;
  getUrl: () => string;
  getNavigationIndex: () => number | null;
  createSessionId: () => string;
  addPopstateListener: (listener: (event: HistoryPopstate) => void) => void;
};

const browserGlobal = globalThis as typeof globalThis & HistoryTrackerHost;

export function historyStateWithPoint(
  state: HistoryState,
  point: number,
  sessionId: string,
): Record<string, unknown> {
  return {
    ...(state && typeof state === "object" ? state : {}),
    [HISTORY_POINT_KEY]: { point, sessionId },
  };
}

function historyPointFromState(
  state: unknown,
  sessionId: string,
): number | null {
  if (!state || typeof state !== "object") return null;
  const marker = (state as Record<string, unknown>)[HISTORY_POINT_KEY];
  if (!marker || typeof marker !== "object") return null;
  const markerRecord = marker as Record<string, unknown>;
  if (markerRecord.sessionId !== sessionId) return null;
  const point = markerRecord.point;
  return typeof point === "number" && Number.isSafeInteger(point)
    ? point
    : null;
}

type GuardedPopstate = {
  targetUrl: string;
  targetNavigationIndex: number | null;
  state: unknown;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
};

type HistoryPopstateGuardDependencies = {
  getCurrentSnapshot: () => HistorySnapshot | null;
  isDirty: () => boolean;
  confirmDiscard: () => boolean;
  go: (delta: number) => void;
  restoreCurrentEntry: (snapshot: HistorySnapshot) => void;
};

export function createHistoryPopstateGuard({
  getCurrentSnapshot,
  isDirty,
  confirmDiscard,
  go,
  restoreCurrentEntry,
}: HistoryPopstateGuardDependencies) {
  let restoring:
    | Pick<HistorySnapshot, "currentPoint" | "sessionId" | "navigationIndex">
    | undefined;

  return (event: GuardedPopstate) => {
    const current = getCurrentSnapshot();
    if (!current) return false;
    const targetPoint = historyPointFromState(event.state, current.sessionId);

    const returnedByNativeIndex =
      restoring?.navigationIndex !== null &&
      restoring?.navigationIndex === event.targetNavigationIndex;
    const returnedByPoint =
      targetPoint !== null &&
      restoring?.sessionId === current.sessionId &&
      restoring.currentPoint === targetPoint;
    if (restoring && (returnedByNativeIndex || returnedByPoint)) {
      restoring = undefined;
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }

    if (
      !shouldBlockUrl(isDirty(), current.currentUrl, event.targetUrl) ||
      confirmDiscard()
    ) {
      return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const nativeDelta =
      current.navigationIndex !== null && event.targetNavigationIndex !== null
        ? current.navigationIndex - event.targetNavigationIndex
        : null;
    const pointDelta =
      targetPoint === null ? null : current.currentPoint - targetPoint;
    const restorationDelta = nativeDelta ?? pointDelta;
    if (restorationDelta === null || restorationDelta === 0) {
      restoreCurrentEntry(current);
      return true;
    }

    restoring = {
      currentPoint: current.currentPoint,
      sessionId: current.sessionId,
      navigationIndex: current.navigationIndex,
    };
    go(restorationDelta);
    return true;
  };
}

export function installHistoryStateTracker(
  host: HistoryTrackerHost,
  runtime: HistoryTrackerRuntime,
): HistoryTracker {
  if (host.__weaverHistoryTracker) return host.__weaverHistoryTracker;

  const originalPushState = runtime.history.pushState.bind(runtime.history);
  const originalReplaceState = runtime.history.replaceState.bind(
    runtime.history,
  );
  const initialNavigationIndex = runtime.getNavigationIndex();
  const tracker: HistoryTracker = {
    currentPoint: initialNavigationIndex ?? 0,
    sessionId: runtime.createSessionId(),
    navigationIndex: initialNavigationIndex,
    currentUrl: runtime.getUrl(),
    currentState: runtime.history.state,
  };
  originalReplaceState(
    historyStateWithPoint(
      runtime.history.state as HistoryState,
      tracker.currentPoint,
      tracker.sessionId,
    ),
    "",
    tracker.currentUrl,
  );
  tracker.currentState = runtime.history.state;
  host.__weaverHistoryTracker = tracker;

  runtime.history.pushState = function pushState(data, unused, url) {
    const nextPoint = tracker.currentPoint + 1;
    const result = originalPushState(
      historyStateWithPoint(data as HistoryState, nextPoint, tracker.sessionId),
      unused,
      url,
    );
    tracker.currentPoint = nextPoint;
    tracker.navigationIndex = runtime.getNavigationIndex();
    tracker.currentUrl = runtime.getUrl();
    tracker.currentState = runtime.history.state;
    return result;
  };
  runtime.history.replaceState = function replaceState(data, unused, url) {
    const result = originalReplaceState(
      historyStateWithPoint(
        data as HistoryState,
        tracker.currentPoint,
        tracker.sessionId,
      ),
      unused,
      url,
    );
    tracker.navigationIndex = runtime.getNavigationIndex();
    tracker.currentUrl = runtime.getUrl();
    tracker.currentState = runtime.history.state;
    return result;
  };

  runtime.addPopstateListener((event) => {
    const targetNavigationIndex = runtime.getNavigationIndex();
    const guarded = host.__weaverHistoryPopstateGuard?.({
      targetUrl: runtime.getUrl(),
      targetNavigationIndex,
      state: event.state,
      preventDefault: () => event.preventDefault(),
      stopImmediatePropagation: () => event.stopImmediatePropagation(),
    });
    if (guarded) return;

    const targetPoint = historyPointFromState(event.state, tracker.sessionId);
    if (targetPoint !== null) {
      tracker.currentPoint = targetPoint;
    } else {
      if (targetNavigationIndex === null) {
        tracker.sessionId = runtime.createSessionId();
        tracker.currentPoint = 0;
      } else {
        tracker.currentPoint = targetNavigationIndex;
      }
      originalReplaceState(
        historyStateWithPoint(
          event.state as HistoryState,
          tracker.currentPoint,
          tracker.sessionId,
        ),
        "",
        runtime.getUrl(),
      );
    }
    tracker.navigationIndex = targetNavigationIndex;
    tracker.currentUrl = runtime.getUrl();
    tracker.currentState = runtime.history.state;
  });

  return tracker;
}

function browserNavigationIndex(): number | null {
  const navigation = (
    window as typeof window & {
      navigation?: { currentEntry?: { index?: number } | null };
    }
  ).navigation;
  const index = navigation?.currentEntry?.index;
  return typeof index === "number" && Number.isSafeInteger(index)
    ? index
    : null;
}

function installBrowserHistoryStateTracker() {
  return installHistoryStateTracker(browserGlobal, {
    history: window.history,
    getUrl: () => window.location.href,
    getNavigationIndex: browserNavigationIndex,
    createSessionId: () => window.crypto.randomUUID(),
    addPopstateListener: (listener) =>
      window.addEventListener("popstate", (event) => listener(event)),
  });
}

export function HistoryStateTracker() {
  useLayoutEffect(() => {
    installBrowserHistoryStateTracker();
  }, []);
  return null;
}

export function shouldBlockUrl(
  dirty: boolean,
  currentUrl: string,
  targetUrl: string,
): boolean {
  if (!dirty) return false;

  const current = new URL(currentUrl);
  const target = new URL(targetUrl, current);
  return target.origin === current.origin && target.href !== current.href;
}

export function shouldBlockNavigation(
  dirty: boolean,
  target: Element | null,
): boolean {
  const anchor = target?.closest("a[href]");
  if (!dirty || !(anchor instanceof HTMLAnchorElement)) return false;
  return shouldBlockUrl(true, window.location.href, anchor.href);
}

export function shouldProceedWithNavigation(
  dirty: boolean,
  confirmDiscard: () => boolean,
): boolean {
  return !dirty || confirmDiscard();
}

export function createProgrammaticNavigationGuard(input: {
  isDirty: () => boolean;
  currentUrl: () => string;
  confirmDiscard: () => boolean;
}) {
  return (href: string) =>
    !shouldBlockUrl(input.isDirty(), input.currentUrl(), href) ||
    input.confirmDiscard();
}

export function confirmNavigation(href: string): boolean {
  return browserGlobal.__weaverNavigationGuard?.(href) ?? true;
}

let unloadPromptSuppressed = false;

// For an already-confirmed full-page exit (sign-out); returns the undo for a failed exit.
export function suppressUnsavedPrompt(): () => void {
  unloadPromptSuppressed = true;
  return () => {
    unloadPromptSuppressed = false;
  };
}

export function shouldPromptBeforeUnload(dirty: boolean): boolean {
  return dirty && !unloadPromptSuppressed;
}

export function useUnsavedChangesGuard(dirty: boolean) {
  const isDirty = useEffectEvent(() => dirty);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldPromptBeforeUnload(isDirty())) return;

      event.preventDefault();
      event.returnValue = "";
    };

    const handleClick = (event: MouseEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.button !== 0
      )
        return;
      const target = event.target;
      if (
        !shouldBlockNavigation(
          isDirty(),
          target instanceof Element ? target : null,
        ) ||
        shouldProceedWithNavigation(isDirty(), () =>
          window.confirm(UNSAVED_CHANGES_CONFIRMATION),
        )
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const popstateGuard = createHistoryPopstateGuard({
      getCurrentSnapshot: () => browserGlobal.__weaverHistoryTracker ?? null,
      isDirty,
      confirmDiscard: () => window.confirm(UNSAVED_CHANGES_CONFIRMATION),
      go: (delta) => window.history.go(delta),
      restoreCurrentEntry: (snapshot) =>
        window.history.replaceState(
          snapshot.currentState,
          "",
          snapshot.currentUrl,
        ),
    });
    const navigationGuard = createProgrammaticNavigationGuard({
      isDirty,
      currentUrl: () => window.location.href,
      confirmDiscard: () => window.confirm(UNSAVED_CHANGES_CONFIRMATION),
    });
    const previousNavigationGuard = browserGlobal.__weaverNavigationGuard;
    browserGlobal.__weaverNavigationGuard = navigationGuard;
    const previousPopstateGuard = browserGlobal.__weaverHistoryPopstateGuard;
    browserGlobal.__weaverHistoryPopstateGuard = popstateGuard;

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (browserGlobal.__weaverNavigationGuard === navigationGuard) {
        browserGlobal.__weaverNavigationGuard = previousNavigationGuard;
      }
      if (browserGlobal.__weaverHistoryPopstateGuard === popstateGuard) {
        browserGlobal.__weaverHistoryPopstateGuard = previousPopstateGuard;
      }
      document.removeEventListener("click", handleClick, true);
    };
  }, []);
}
