import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; myRole: string }>,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    project: { list: { useQuery: () => ({ data: mocked.projects }) } },
    assistant: { listCitations: { useQuery: () => ({ data: [] }) } },
    wiki: { saveTarget: { useQuery: () => ({ data: undefined }) } },
    document: { create: { useMutation: () => ({ isPending: false }) } },
  },
}));

import { SaveAsPageButton } from "./SaveAsPageDialog";

const render = (text = "# Answer\n\nBody") =>
  renderToStaticMarkup(
    <SaveAsPageButton conversationId="c" messageId="m" text={text} />,
  );

describe("SaveAsPageButton", () => {
  beforeEach(() => {
    mocked.projects = [];
  });

  it("is offered to Editors and above only", () => {
    mocked.projects = [{ id: "p1", name: "P", myRole: "Viewer" }];
    expect(render()).not.toContain("Save as page");
    mocked.projects = [
      { id: "p1", name: "P", myRole: "Viewer" },
      { id: "p2", name: "Q", myRole: "Editor" },
    ];
    expect(render()).toContain("Save as page");
  });

  it("is not offered for an empty answer", () => {
    mocked.projects = [{ id: "p1", name: "P", myRole: "Owner" }];
    expect(render("  ")).toBe("");
  });
});
