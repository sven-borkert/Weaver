import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync, readlinkSync } from "node:fs";
import test from "node:test";

const skillFiles = globSync(".claude/skills/*/SKILL.md").sort();
const instructionFiles = ["CLAUDE.md", "docs/setup.md", ...skillFiles];
const obsoleteRootPath =
  /(^|[\s`('"=])((?:src|prisma|generated)\/|tests\/(?:integration|e2e)\/)/;

test("canonical agent instructions use current monorepo paths", () => {
  const obsolete = instructionFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return source
      .split("\n")
      .flatMap((line, index) =>
        obsoleteRootPath.test(line)
          ? [`${file}:${index + 1}: ${line.trim()}`]
          : [],
      );
  });

  assert.deepEqual(obsolete, []);
});

test("concrete repository paths in canonical instructions exist", () => {
  const missing = instructionFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/`([^`\n]+)`/g)].flatMap((match) => {
      const path = match[1];
      if (
        !/^(?:apps|packages|scripts|docs|docker|\.claude|\.codex)\//.test(path)
      ) {
        return [];
      }
      if (/[\s*{}<>|$]/.test(path)) return [];
      if (
        !/(?:\/(?:src|tests|prisma)\/|\/(?:src|tests|prisma)\/$|\.[a-z\d]+$)/i.test(
          path,
        )
      ) {
        return [];
      }
      return existsSync(path) ? [] : [`${file}: ${path}`];
    });
  });

  assert.deepEqual(missing, []);
});

test("consumer instructions use the public database package API", () => {
  const consumerFiles = instructionFiles.filter(
    (file) => file !== ".claude/skills/weaver-database/SKILL.md",
  );
  const directClientGuidance = consumerFiles.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return source
      .split("\n")
      .flatMap((line, index) =>
        /imports?.*generated\/prisma/i.test(line)
          ? [`${file}:${index + 1}: ${line.trim()}`]
          : [],
      );
  });

  assert.deepEqual(directClientGuidance, []);
});

test("Codex discovers the canonical Claude instructions and skills", () => {
  assert.equal(readlinkSync("AGENTS.md"), "CLAUDE.md");
  assert.ok(skillFiles.length > 0);

  for (const skillFile of skillFiles) {
    const name = skillFile.split("/").at(-2);
    assert.equal(
      readlinkSync(`.codex/skills/${name}`),
      `../../.claude/skills/${name}`,
    );
  }
});
