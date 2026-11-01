import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  info: {
    version: null as string | null,
    buildTime: null as string | null,
    commitSha: null as string | null,
  },
}));

vi.mock("~/lib/buildInfo", () => ({
  getClientBuildInfo: () => mocked.info,
}));

import { AppVersionFooter } from "./AppVersionFooter";

function render(compact = false) {
  return renderToStaticMarkup(<AppVersionFooter compact={compact} />);
}

afterEach(() => {
  mocked.info = { version: null, buildTime: null, commitSha: null };
});

describe("AppVersionFooter", () => {
  it("renders the version and a build timestamp slot", () => {
    mocked.info = {
      version: "v0.1.92",
      buildTime: "2026-09-17T08:30:00.000Z",
      commitSha: "0123456789abcdef0123",
    };

    const html = render();

    expect(html).toContain("v0.1.92");
    expect(html).toContain("Built");
    // ClientDateTime stays a placeholder until mount, so SSR cannot mismatch.
    expect(html).toContain("Date and time loading");
    expect(html).toContain("Commit 0123456789ab");
  });

  it("renders only the version in the collapsed rail", () => {
    mocked.info = {
      version: "v0.1.92",
      buildTime: "2026-09-17T08:30:00.000Z",
      commitSha: null,
    };

    const html = render(true);

    expect(html).toContain("v0.1.92");
    expect(html).not.toContain("Built");
    expect(html).toContain("Build 2026-09-17T08:30:00.000Z");
  });

  it("renders nothing without build metadata", () => {
    expect(render()).toBe("");
    expect(render(true)).toBe("");
  });

  it("ignores an unparsable build timestamp", () => {
    mocked.info = {
      version: "v0.1.92",
      buildTime: "not-a-date",
      commitSha: null,
    };

    const html = render();

    expect(html).toContain("v0.1.92");
    expect(html).not.toContain("Built");
  });
});
