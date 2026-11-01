import { describe, expect, it } from "vitest";
import { CoreError } from "../../errors";
import {
  parseListRows,
  parseSummaryRows,
  parseSeenRows,
  parsePruneCount,
} from "./rows";

const id = "11111111-1111-4111-8111-111111111111";
const at = new Date("2026-09-08T12:00:00.000Z");
const row = {
  id,
  kind: "task",
  title: "Daily digest",
  projectId: id,
  projectName: "Project",
  state: "succeeded",
  sourceStatus: "succeeded",
  createdAt: "2026-09-08T12:00:00",
  startedAt: null,
  finishedAt: "2026-09-08T12:00:00.000",
  sortAt: at.toISOString(),
  progress: null,
  errorCode: null,
  errorMessage: null,
  destination: { kind: "task", projectId: id, taskId: id },
  revision: "a".repeat(32),
  isPersonal: true,
  unseen: true,
};
const envelope = (items: unknown[] = [row]) => [
  { items, asOf: at, windowStart: at },
];
function sanitized(action: () => unknown) {
  try {
    action();
    throw new Error("Expected validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Invalid background work result",
      details: undefined,
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  }
}
describe("background work SQL result validation", () => {
  it("preserves valid UTC timestamp strings and nullable source times", () => {
    expect(parseListRows(envelope())[0].items[0]).toEqual(row);
    expect(parseListRows(envelope([]))[0].items).toEqual([]);
  });
  it.each([
    { id: "secret" },
    { state: "secret" },
    { kind: "secret" },
    { sourceStatus: "secret" },
    { createdAt: "2026-02-30T12:00:00" },
    { finishedAt: "secret" },
    { isPersonal: "true" },
    { unseen: 1 },
    { revision: "secret" },
    { errorCode: "secret provider message" },
    { errorMessage: "x".repeat(501) },
    { destination: { kind: "task", projectId: id, taskId: "secret" } },
    { destination: { kind: "assistant", conversationId: id } },
    { progress: { ready: -1, total: 1, failed: 0 } },
    { secret: "provider response" },
  ])("rejects malformed source row %#", (patch) =>
    sanitized(() => parseListRows(envelope([{ ...row, ...patch }]))),
  );
  it("rejects wrong envelope cardinality, types, extras and oversized pages", () => {
    for (const value of [
      [],
      [...envelope(), ...envelope()],
      [{ ...envelope()[0], asOf: "secret" }],
      [{ ...envelope()[0], secret: true }],
      envelope(Array(52).fill(row)),
    ])
      sanitized(() => parseListRows(value));
  });
  it("accepts a bounded stored error message alongside its code", () => {
    const withMessage = {
      ...row,
      errorCode: "TASK_FAILED",
      errorMessage: "Provider unavailable (ref 0123abcd)",
    };
    expect(
      parseListRows(envelope([withMessage]))[0].items[0]?.errorMessage,
    ).toBe("Provider unavailable (ref 0123abcd)");
  });
  it("bounds errorMessage by character count, not UTF-16 code units", () => {
    const astral = "😀".repeat(500);
    const withAstralMessage = {
      ...row,
      errorCode: "TASK_FAILED",
      errorMessage: astral,
    };
    expect(
      parseListRows(envelope([withAstralMessage]))[0].items[0]?.errorMessage,
    ).toBe(astral);
    sanitized(() =>
      parseListRows(
        envelope([
          { ...row, errorCode: "TASK_FAILED", errorMessage: "😀".repeat(501) },
        ]),
      ),
    );
  });
  it("validates every typed destination", () => {
    for (const destination of [
      { kind: "import", projectId: id, fileId: id },
      { kind: "assistant", conversationId: id },
      { kind: "knowledge", projectId: id },
    ]) {
      expect(
        parseListRows(
          envelope([{ ...row, kind: destination.kind, destination }]),
        )[0].items[0]?.destination,
      ).toEqual(destination);
    }
  });
  it("validates saturated summary counts and real dates", () => {
    expect(
      parseSummaryRows([{ active: 0, unseen: 100, observedAt: at }])[0].unseen,
    ).toBe(100);
    for (const value of [
      [],
      [{ active: 101, unseen: 0, observedAt: at }],
      [{ active: -1, unseen: 0, observedAt: at }],
      [{ active: 0.5, unseen: 0, observedAt: at }],
      [{ active: 0, unseen: 0, observedAt: new Date("invalid") }],
      [{ active: 0, unseen: 0, observedAt: at.toISOString() }],
    ])
      sanitized(() => parseSummaryRows(value));
  });
  it("validates exact acknowledgement response UUID rows and bounded pruning counts", () => {
    expect(parseSeenRows([{ workId: id }])).toEqual([{ workId: id }]);
    expect(parseSeenRows([])).toEqual([]);
    for (const value of [
      [{ workId: "secret" }],
      Array(51).fill({ workId: id }),
      [{ workId: id, secret: true }],
    ])
      sanitized(() => parseSeenRows(value));
    expect(parsePruneCount(0)).toBe(0);
    expect(parsePruneCount(5000)).toBe(5000);
    for (const value of [-1, 5001, 1.5, "secret", null])
      sanitized(() => parsePruneCount(value));
  });
});
