import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  me: undefined as { role: string } | undefined,
}));

vi.mock("~/trpc/react", () => ({
  api: { account: { me: { useQuery: () => ({ data: mocked.me }) } } },
}));

import { RunStateStrip } from "./RunStateStrip";

const failed = {
  status: "failed" as const,
  hasText: false,
  queuedForMs: 0,
  errorCode: "PROVIDER_UNAVAILABLE",
  errorMessage:
    "Could not reach the LLM provider: connection refused [ECONNREFUSED] (ref a3f9c2e1)",
  retrying: false,
  attempt: 1,
};

describe("RunStateStrip", () => {
  beforeEach(() => {
    mocked.me = undefined;
  });

  it("shows the cause and a plain reference to non-admins", () => {
    const markup = renderToStaticMarkup(<RunStateStrip {...failed} />);
    expect(markup).toContain("connection refused [ECONNREFUSED]");
    expect(markup).toContain("ref a3f9c2e1");
    expect(markup).not.toContain("<a");
  });

  it("links the reference to the diagnostics page for admins", () => {
    mocked.me = { role: "Admin" };
    const markup = renderToStaticMarkup(<RunStateStrip {...failed} />);
    expect(markup).toContain('href="/admin/diagnostics?ref=a3f9c2e1"');
    expect(markup).toContain("connection refused [ECONNREFUSED]");
  });
});
