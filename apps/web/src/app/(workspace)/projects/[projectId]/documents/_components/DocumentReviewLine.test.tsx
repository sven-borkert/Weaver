import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vitest";

import { DocumentReviewLine } from "./DocumentReviewLine";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const day = 24 * 60 * 60 * 1000;
const review = {
  reviewers: [
    { type: "user" as const, id: "u1", name: "Ada", resolved: true },
    { type: "group" as const, id: "g1", name: "Ops", resolved: true },
  ],
  everyMonths: 12,
  since: new Date("2025-01-01T00:00:00Z"),
  lastReviewedAt: null,
  reviewedBy: null,
  dueAt: new Date(Date.now() + 90 * day),
};

let renderer: ReactTestRenderer;
async function mount(
  value: Parameters<typeof DocumentReviewLine>[0]["review"],
) {
  await act(async () => {
    renderer = create(<DocumentReviewLine review={value} />);
  });
}
const text = () => {
  const collect = (node: unknown): string =>
    typeof node === "string"
      ? node
      : node && typeof node === "object" && "children" in node
        ? ((node as { children: unknown[] | null }).children ?? [])
            .map(collect)
            .join("")
        : "";
  return collect(renderer.toJSON());
};
const dueSpan = () =>
  renderer.root.find(
    (node) =>
      node.type === "span" &&
      node.children.some(
        (child) =>
          typeof child === "string" &&
          /Next review due|Review overdue since|Review due now/.test(child),
      ),
  );

afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

describe("DocumentReviewLine", () => {
  it("renders nothing without a review", async () => {
    await mount(null);
    expect(renderer.toJSON()).toBeNull();
  });

  it("shows a never-reviewed document as due now, without a date", async () => {
    await mount({ ...review, dueAt: new Date(Date.now() - 3 * day) });
    const line = text();
    expect(line).toContain("Reviewers: Ada, Ops");
    expect(line).toContain("Not reviewed yet · Review due now");
    expect(line).not.toContain("overdue");
    expect(line).not.toContain("Next review due");
    expect(renderer.root.findAllByType("time")).toHaveLength(0);
    expect(dueSpan().props.className).toContain("text-review");
    expect(dueSpan().props.className).not.toContain("text-danger");
  });

  it("shows the next due date of a reviewed document", async () => {
    await mount({
      ...review,
      lastReviewedAt: new Date("2026-09-01T00:00:00Z"),
      reviewedBy: { id: "u1", name: "Ada" },
    });
    expect(text()).toContain("Next review due");
    expect(dueSpan().props.className).not.toContain("text-danger");
    expect(dueSpan().props.className).not.toContain("text-review");
  });

  it("shows the last review and who did it", async () => {
    await mount({
      ...review,
      lastReviewedAt: new Date("2026-09-01T00:00:00Z"),
      reviewedBy: { id: "u1", name: "Ada" },
    });
    const line = text();
    expect(line).toContain("Last reviewed");
    expect(line).toContain("by Ada");
    expect(line).not.toContain("Not reviewed yet");
    expect(
      renderer.root
        .findAllByType("time")
        .map((t) => (t.props as { dateTime: string }).dateTime),
    ).toContain("2026-09-01T00:00:00.000Z");
  });

  it("marks an overdue review with text and the danger colour", async () => {
    await mount({
      ...review,
      lastReviewedAt: new Date("2025-01-01T00:00:00Z"),
      dueAt: new Date(Date.now() - 3 * day),
    });
    expect(text()).toContain("Review overdue since");
    expect(text()).not.toContain("Next review due");
    expect(dueSpan().props.className).toContain("text-danger");
  });

  it("highlights a review due within 30 days", async () => {
    await mount({
      ...review,
      lastReviewedAt: new Date("2025-01-01T00:00:00Z"),
      dueAt: new Date(Date.now() + 10 * day),
    });
    expect(text()).toContain("Next review due");
    expect(dueSpan().props.className).toContain("text-review");
  });

  it("names the project owners when no reviewer is set", async () => {
    await mount({ ...review, reviewers: [] });
    expect(text()).toContain("Reviewers: Project owners");
  });
});
