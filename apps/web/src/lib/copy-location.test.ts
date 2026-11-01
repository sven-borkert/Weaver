import { describe, expect, it } from "vitest";
import { formatItemLocation } from "./copy-location";

const base = {
  projectName: "Sven Borkert's workspace",
  projectId: "940277d6-e696-457c-9232-45c4bd826d7d",
  kind: "Document" as const,
  title: "AI Training Agenda",
  itemId: "380b3d9c-31cf-43a4-84e5-fd479e9c43e1",
};

describe("formatItemLocation", () => {
  it("names the project, folder, document and both IDs", () => {
    expect(formatItemLocation({ ...base, folder: ["Trainings", "2026"] })).toBe(
      [
        "Project: Sven Borkert's workspace",
        "Folder: Trainings / 2026",
        "Document: AI Training Agenda",
        "Project ID: 940277d6-e696-457c-9232-45c4bd826d7d",
        "Document ID: 380b3d9c-31cf-43a4-84e5-fd479e9c43e1",
      ].join("\n"),
    );
  });

  it("marks items at the project root", () => {
    expect(formatItemLocation({ ...base, folder: [] })).toContain(
      "Folder: (project root)",
    );
  });

  it("uses the table labels for tables", () => {
    const text = formatItemLocation({ ...base, kind: "Table", folder: [] });
    expect(text).toContain("Table: AI Training Agenda");
    expect(text).toContain("Table ID: 380b3d9c-31cf-43a4-84e5-fd479e9c43e1");
  });
});
