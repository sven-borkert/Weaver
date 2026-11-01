import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FileStageBadge } from "./FileStageBadge";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

describe("FileStageBadge", () => {
  it.each([
    ["pending", "Queued"],
    ["parsing", "Parsing"],
    ["extracting", "Extracting"],
    ["linking", "Linking"],
    ["ready", "Ready for review"],
    ["accepting", "Accepting"],
    ["accepted", "Accepted"],
    ["rejected", "Rejected"],
    ["failed", "Failed"],
    ["blocked_configuration", "Needs configuration"],
  ] as const)("labels %s", (status, label) => {
    expect(renderToStaticMarkup(<FileStageBadge status={status} />)).toContain(
      label,
    );
  });
  it("makes a failure available as a tooltip", () => {
    expect(
      renderToStaticMarkup(
        <FileStageBadge
          status="failed"
          failureMessage="PDF parsing is unavailable"
        />,
      ),
    ).toContain('title="PDF parsing is unavailable"');
    expect(
      renderToStaticMarkup(<FileStageBadge status="ready" />),
    ).not.toContain("title=");
  });
  it("points configuration failures to AI settings", () => {
    expect(
      renderToStaticMarkup(<FileStageBadge status="blocked_configuration" />),
    ).toContain('href="/admin/settings/ai"');
  });
});
