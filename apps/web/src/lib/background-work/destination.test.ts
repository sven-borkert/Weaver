import { describe, expect, it } from "vitest";

import { backgroundWorkHref } from "./destination";

describe("background work destinations", () => {
  it.each([
    [
      { kind: "task", projectId: "p", taskId: "t" } as const,
      "/projects/p/tasks/t",
    ],
    [
      { kind: "import", projectId: "p", fileId: "f" } as const,
      "/projects/p/imports/f",
    ],
    [{ kind: "assistant", conversationId: "c" } as const, "/assistant/c"],
    [{ kind: "knowledge", projectId: "p" } as const, "/projects/p/settings"],
  ])("maps %o", (destination, href) => {
    expect(backgroundWorkHref(destination)).toBe(href);
  });
});
