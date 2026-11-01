import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => ({
  data: undefined as { id: string; name: string } | null | undefined,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    scheduledTask: {
      byOutputDocument: { useQuery: () => ({ data: query.data }) },
    },
  },
}));

import { MaintainedByTaskBanner } from "./MaintainedByTaskBanner";

describe("MaintainedByTaskBanner", () => {
  it("renders nothing when no task maintains the document", () => {
    query.data = null;
    expect(
      renderToStaticMarkup(
        <MaintainedByTaskBanner projectId="p" documentId="d" />,
      ),
    ).toBe("");
  });

  it("names the task and links to it", () => {
    query.data = { id: "t1", name: "Weekly digest" };
    const html = renderToStaticMarkup(
      <MaintainedByTaskBanner projectId="p" documentId="d" />,
    );
    expect(html).toContain("Weekly digest");
    expect(html).toContain("/projects/p/tasks/t1");
    expect(html).toContain("replaced on the next run");
  });
});
