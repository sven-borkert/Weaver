import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));
vi.mock("~/trpc/react", () => {
  const mutation = () => ({ useMutation: () => ({ isPending: false }) });
  const query = (data: unknown) => ({
    useQuery: () => ({ data, error: null, isLoading: false, refetch: vi.fn() }),
  });
  return {
    api: {
      useUtils: () => ({}),
      wiki: {
        suggestions: query([
          { id: "s1", text: "Prefer short titles.", createdAt: new Date() },
        ]),
        reviewGuide: query(undefined),
        usage: query({
          tokens: 1_234,
          costMicros: 500_000n,
          currency: "USD",
          indexingCostMicros: null,
        }),
        enable: mutation(),
        disable: mutation(),
        revokeAgent: mutation(),
        update: mutation(),
        clearLintPause: mutation(),
        setGuideDocument: mutation(),
        approveGuide: mutation(),
        resolveSuggestion: mutation(),
      },
      document: { list: query({ items: [] }) },
    },
  };
});

import { GuideReviewBody } from "./ReviewGuideDialog";
import { WikiSettings } from "./WikiCard";
import type { RouterOutputs } from "~/trpc/react";

type Settings = RouterOutputs["wiki"]["settings"];

const base: Settings = {
  projectId: "p1",
  revision: 0,
  enabled: false,
  routeReady: false,
  agent: null,
  enabledAt: null,
  guide: {
    documentId: null,
    title: null,
    approved: false,
    approvedAt: null,
    approvedById: null,
  },
  overviewDocumentId: null,
  sourcesFolderId: null,
  openSuggestions: 0,
  destructiveBudget24h: 100_000,
  destructivePausedAt: null,
  spendAlertCentsPerDay: null,
  lintSchedule: null,
  lintTimezone: "UTC",
  lintNextRunAt: null,
  lintPausedAt: null,
  lintConsecutiveFailures: 0,
  lintSkipped: null,
  reportDocumentId: null,
};
const on: Settings = {
  ...base,
  revision: 3,
  enabled: true,
  routeReady: true,
  agent: { id: "a", createdAt: new Date("2026-11-03"), live: true },
  guide: {
    documentId: "g1",
    title: "Wiki guide",
    approved: true,
    approvedAt: new Date("2026-11-03"),
    approvedById: null,
  },
};
const render = (settings: Settings, isOwner: boolean) =>
  renderToStaticMarkup(
    <WikiSettings projectId="p1" isOwner={isOwner} settings={settings} />,
  );

it("offers Enable to an Owner of a project without a wiki and mentions the shared route", () => {
  const html = render(base, true);
  expect(html).toContain("Enable wiki agent");
  expect(html).toContain("No model route");
  expect(html).toContain("stops the agent in every project");
});

it("shows a Maintainer the state but no Enable button", () => {
  const html = render(base, false);
  expect(html).not.toContain("Enable wiki agent");
  expect(html).toContain("A project Owner can enable it.");
});

it("shows approval, suggestions and Owner controls when enabled", () => {
  const html = render(on, true);
  expect(html).toContain("Model route ready");
  expect(html).toContain("Approved 2026-11-03");
  expect(html).toContain("Review guide");
  expect(html).toContain("Written by the agent");
  expect(html).toContain("Prefer short titles.");
  expect(html).toContain("Open guide editor");
  expect(html).toContain("Revoke agent identity");
  expect(html).toContain("24-hour destructive budget");
});

it("hides Owner controls from a Maintainer and flags an unapproved guide", () => {
  const html = render(
    { ...on, guide: { ...on.guide, approved: false, approvedAt: null } },
    false,
  );
  expect(html).toContain("Not approved");
  expect(html).not.toContain("Revoke agent identity");
  expect(html).not.toContain("Use a different guide page");
});

it("renders the exact guide text, removals, flags and diff for review", () => {
  const html = renderToStaticMarkup(
    <GuideReviewBody
      review={{
        revision: 3,
        documentId: "g1",
        title: "Wiki guide",
        text: "Line one\nSee https://x.test",
        digest: "d".repeat(64),
        bytes: 30,
        tooLarge: false,
        removed: [{ kind: "zero-width character", count: 2 }],
        matchesApproved: false,
        approvedAt: null,
        diff: [
          { type: "del", text: "old" },
          { type: "add", text: "new" },
        ],
        flags: [
          {
            line: 2,
            text: "See https://x.test",
            reason: "Mentions an external address",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("Exact text every run receives");
  expect(html).toContain("2 zero-width characters");
  expect(html).toContain("Line 2: Mentions an external address");
  expect(html).toContain("Changes since the approved text");
  expect(html).toContain("new");
});

it("refuses to show an oversized guide", () => {
  const html = renderToStaticMarkup(
    <GuideReviewBody
      review={{
        revision: 1,
        documentId: "g1",
        title: "G",
        text: "",
        digest: "d".repeat(64),
        bytes: 20_000,
        tooLarge: true,
        removed: [],
        matchesApproved: false,
        approvedAt: null,
        diff: [],
        flags: [],
      }}
    />,
  );
  expect(html).toContain("16,000 bytes");
  expect(html).not.toContain("Exact text every run receives");
});

it("shows the schedule, a skipped slot and a pause with Resume for an Owner only", () => {
  const scheduled: Settings = {
    ...on,
    lintSchedule: { kind: "daily", hour: 3, minute: 0 },
    lintNextRunAt: new Date("2026-11-04T03:00:00Z"),
    lintPausedAt: new Date("2026-11-03T03:00:00Z"),
    lintConsecutiveFailures: 5,
    lintSkipped: { at: new Date("2026-11-02T03:00:00Z"), reason: "missed" },
  };
  const owner = render(scheduled, true);
  expect(owner).toContain("Daily at 03:00, UTC");
  expect(owner).toContain("paused after 5 failed runs");
  expect(owner).toContain("Resume");
  expect(owner).toContain("was skipped");
  expect(owner).toContain("Maintenance schedule");
  const maintainer = render(scheduled, false);
  expect(maintainer).toContain("paused after 5 failed runs");
  expect(maintainer).not.toContain("Resume");
  expect(maintainer).not.toContain("Maintenance schedule");
  expect(render(on, true)).toContain("Scheduled maintenance is off.");
});
