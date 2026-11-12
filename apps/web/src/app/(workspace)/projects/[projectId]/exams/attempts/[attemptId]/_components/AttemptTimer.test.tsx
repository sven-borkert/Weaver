import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { AttemptTimer } from "./AttemptTimer";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("announces only countdown milestones and expires once", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const expired = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <AttemptTimer
        deadlineAt={new Date(301000)}
        serverNow={new Date(0)}
        receivedAt={0}
        onExpired={expired}
      />,
    );
  });
  try {
    const announcement = () =>
      renderer.root
        .findByProps({ "aria-live": "polite" })
        .children.filter((child): child is string => typeof child === "string")
        .join("");
    expect(
      renderer.root.findByProps({ role: "timer" }).props["aria-live"],
    ).not.toBe("polite");
    expect(announcement()).toBe("");
    await act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(announcement()).toBe("5 minutes remaining.");
    await act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(announcement()).toBe("5 minutes remaining.");
    await act(() => {
      vi.advanceTimersByTime(239000);
    });
    expect(announcement()).toBe("1 minute remaining.");
    await act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(announcement()).toBe("Time is up.");
    expect(expired).toHaveBeenCalledOnce();
    await act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(expired).toHaveBeenCalledOnce();
  } finally {
    await act(() => renderer.unmount());
  }
});
