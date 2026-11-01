import { describe, expect, it } from "vitest";
import { pythonDefinitions } from "./pythonOutline";

const SRC = [
  "#!/usr/bin/env python3",
  "import os",
  "",
  "@dataclass",
  "class Config:",
  "    name: str",
  "",
  "    def method(self):",
  "        return 1",
  "",
  "",
  "async def run(cfg: Config) -> None:",
  "    pass",
  "",
  "def main():",
  "    run(Config('x'))",
  "",
].join("\n");

describe("pythonDefinitions", () => {
  it("lists top-level definitions with decorator groups", () => {
    expect(pythonDefinitions(SRC)).toEqual([
      {
        kind: "class",
        name: "Config",
        line: 4,
        bodyLine: 5,
        start: 3,
        end: 11,
      },
      { kind: "def", name: "run", line: 11, bodyLine: 12, start: 11, end: 14 },
      { kind: "def", name: "main", line: 14, bodyLine: 15, start: 14, end: 16 },
    ]);
  });
  it("ignores indented definitions and returns nothing for plain scripts", () => {
    expect(pythonDefinitions("if x:\n    def f():\n        pass\n")).toEqual(
      [],
    );
    expect(pythonDefinitions("")).toEqual([]);
  });
  it("ends a group at the first module-level statement", () => {
    expect(
      pythonDefinitions(
        'def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n',
      ),
    ).toEqual([
      { kind: "def", name: "main", line: 0, bodyLine: 1, start: 0, end: 4 },
    ]);
  });
  it("keeps column-0 comments and closing brackets inside a group", () => {
    expect(
      pythonDefinitions(
        "def a(\n    x,\n):\n    pass\n# note\n\ndef b():\n    pass\n",
      ),
    ).toEqual([
      { kind: "def", name: "a", line: 0, bodyLine: 3, start: 0, end: 6 },
      { kind: "def", name: "b", line: 6, bodyLine: 7, start: 6, end: 8 },
    ]);
  });
  it("finds the body after a signature with a trailing comment", () => {
    expect(
      pythonDefinitions(
        "def f(\n    x: int,  # count\n) -> int:  # it's fine\n    return x\n",
      ),
    ).toEqual([
      { kind: "def", name: "f", line: 0, bodyLine: 3, start: 0, end: 4 },
    ]);
  });
  it("treats triple-quoted string lines as continuations", () => {
    expect(
      pythonDefinitions(
        'def f():\n    sql = """\nSELECT *\nFROM t\n"""\n    return sql\n',
      ),
    ).toEqual([
      { kind: "def", name: "f", line: 0, bodyLine: 1, start: 0, end: 6 },
    ]);
    expect(pythonDefinitions("X = '''\nclass Foo:\n'''\n")).toEqual([]);
  });

  it("ignores triple quotes in comments and one-line strings", () => {
    expect(
      pythonDefinitions(
        '# don\'t """ here\ndef a():\n    pass\n\ndef b():\n    pass\n',
      ).map((definition) => definition.name),
    ).toEqual(["a", "b"]);
    expect(
      pythonDefinitions('x = \'a"""b\'\ndef f():\n    pass\n').map(
        (definition) => definition.name,
      ),
    ).toEqual(["f"]);
  });
});
