import { beforeEach, describe, expect, it } from "vitest";
import {
  addMembership,
  callerFor,
  makeProject,
  makeUser,
  resetDb,
} from "./_harness";

async function setup(suffix: string) {
  const owner = await makeUser("User", `ti-owner-${suffix}`);
  const project = await makeProject(`TI-${suffix}`);
  await addMembership(project.id, owner.id, "Owner");
  const viewer = await makeUser("User", `ti-viewer-${suffix}`);
  await addMembership(project.id, viewer.id, "Viewer");
  return {
    project,
    caller: callerFor(owner),
    viewerCaller: callerFor(viewer),
  };
}

describe("table.importCsv", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("creates a table with inferred column types and sparse cells", async () => {
    const { project, caller } = await setup("1");
    const created = await caller.table.importCsv({
      projectId: project.id,
      folderPath: [],
      fileName: "monthly_budget.csv",
      content:
        'Item,Amount,Due,Paid\n"Rent, flat",1200,2026-10-01,yes\nPower,,2026-10-05,no\n',
    });
    const table = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(table.title).toBe("Monthly budget");
    expect(table.columns.map((c) => [c.name, c.type])).toEqual([
      ["Item", "text"],
      ["Amount", "number"],
      ["Due", "date"],
      ["Paid", "boolean"],
    ]);
    expect(table.rows).toHaveLength(2);
    const [rent, power] = table.rows;
    const byName = (row: (typeof table.rows)[number], name: string) =>
      row.cells[table.columns.find((c) => c.name === name)!.id];
    expect(byName(rent!, "Item")).toBe("Rent, flat");
    expect(byName(rent!, "Amount")).toBe(1200);
    expect(byName(power!, "Amount")).toBeUndefined();
    expect(byName(power!, "Paid")).toBe(false);
  });

  it("creates an empty table from a header-only file and names blank headers", async () => {
    const { project, caller } = await setup("2");
    const created = await caller.table.importCsv({
      projectId: project.id,
      folderPath: [],
      fileName: "empty.csv",
      content: "a,,a\n",
    });
    const table = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(table.columns.map((c) => c.name)).toEqual([
      "a",
      "Column 2",
      "a (2)",
    ]);
    expect(table.rows).toEqual([]);
  });

  it("keeps deduplicated long column names within the name cap and rejects a blank header", async () => {
    const { project, caller } = await setup("2b");
    const long = "x".repeat(120);
    const created = await caller.table.importCsv({
      projectId: project.id,
      folderPath: [],
      fileName: "long.csv",
      content: `${long},${long}\n1,2\n`,
    });
    const table = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    const names = table.columns.map((c) => c.name);
    expect(names).toHaveLength(2);
    expect(names.every((name) => name.length <= 100)).toBe(true);
    expect(names[1]).toMatch(/ \(2\)$/);
    await expect(
      caller.table.importCsv({
        projectId: project.id,
        folderPath: [],
        fileName: "blank.csv",
        content: ",,\n",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects files over the row and column caps with PRECONDITION_FAILED", async () => {
    const { project, caller } = await setup("3");
    const wide =
      Array.from({ length: 101 }, (_, i) => `c${i}`).join(",") + "\n";
    await expect(
      caller.table.importCsv({
        projectId: project.id,
        folderPath: [],
        fileName: "wide.csv",
        content: wide,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const tall = "a\n" + "x\n".repeat(10_001);
    await expect(
      caller.table.importCsv({
        projectId: project.id,
        folderPath: [],
        fileName: "tall.csv",
        content: tall,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects an oversize file with the 5 MB limit message instead of a raw zod error", async () => {
    const { project, caller } = await setup("3b");
    await expect(
      caller.table.importCsv({
        projectId: project.id,
        folderPath: [],
        fileName: "big.csv",
        content: "a".repeat(5_000_001),
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "The file exceeds the 5 MB table data limit",
    });
  });

  it("rejects malformed CSV with BAD_REQUEST and requires Editor", async () => {
    const { project, caller, viewerCaller } = await setup("4");
    await expect(
      caller.table.importCsv({
        projectId: project.id,
        folderPath: [],
        fileName: "bad.csv",
        content: 'a\n"open',
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      viewerCaller.table.importCsv({
        projectId: project.id,
        folderPath: [],
        fileName: "x.csv",
        content: "a\n1\n",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("flattens control characters inside a quoted multi-line header", async () => {
    const { project, caller } = await setup("6");
    const created = await caller.table.importCsv({
      projectId: project.id,
      folderPath: [],
      fileName: "multiline.csv",
      content: '"a\nb",c\n1,2\n',
    });
    const table = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(table.columns.map((c) => c.name)).toEqual(["a b", "c"]);
  });

  it("prefers tab as the delimiter for a .tsv file even with a comma in the header", async () => {
    const { project, caller } = await setup("7");
    const created = await caller.table.importCsv({
      projectId: project.id,
      folderPath: [],
      fileName: "budget.tsv",
      content: "Name, first\tAge\nA, B\t3\n",
    });
    const table = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(table.columns.map((c) => c.name)).toEqual(["Name, first", "Age"]);
  });

  it("infers datetime, url and longtext columns", async () => {
    const { project, caller } = await setup("8");
    const created = await caller.table.importCsv({
      projectId: project.id,
      folderPath: [],
      fileName: "events.csv",
      content:
        'Start,Link,"Notes"\n2026-09-18T14:30:00Z,https://a.test,"line1\nline2"\n2026-09-19T00:00:00+02:00,http://b.test/x,short\n',
    });
    const table = await caller.table.get({
      projectId: project.id,
      tableId: created.id,
    });
    expect(table.columns.map((c) => [c.name, c.type])).toEqual([
      ["Start", "datetime"],
      ["Link", "url"],
      ["Notes", "longtext"],
    ]);
    const byName = (row: (typeof table.rows)[number], name: string) =>
      row.cells[table.columns.find((c) => c.name === name)!.id];
    const [first, second] = table.rows;
    expect(byName(first!, "Start")).toBe("2026-09-18T14:30:00Z");
    expect(byName(first!, "Link")).toBe("https://a.test");
    expect(byName(first!, "Notes")).toBe("line1\nline2");
    expect(byName(second!, "Start")).toBe("2026-09-19T00:00:00+02:00");
    expect(byName(second!, "Link")).toBe("http://b.test/x");
    expect(byName(second!, "Notes")).toBe("short");
  });

  it("writes into the requested folder", async () => {
    const { project, caller } = await setup("5");
    await caller.tableFolder.create({
      projectId: project.id,
      parentPath: [],
      name: "finance",
    });
    const created = await caller.table.importCsv({
      projectId: project.id,
      folderPath: ["finance"],
      fileName: "q1.csv",
      content: "a\n1\n",
    });
    const tree = await caller.tableFolder.tree({ projectId: project.id });
    expect(tree.tables.find((t) => t.id === created.id)?.path).toBe(
      "tables/finance/q1.table",
    );
  });
});
