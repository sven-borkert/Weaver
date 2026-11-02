import { describe, expect, it } from "vitest";
import { decideOwnership, isOwningCommit } from "./wikiOwnership";

const AGENT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const live = new Set([AGENT]);

const agentCommit = (sha: string, runId = RUN) => ({
  sha,
  trustedAuthor: true,
  wikiAgentId: AGENT,
  operationId: `wiki-run:${runId}:0001`,
  runId,
});
const humanCommit = (sha: string) => ({
  sha,
  trustedAuthor: true,
  wikiAgentId: null,
  operationId: null,
  runId: null,
});

describe("isOwningCommit", () => {
  it("refuses untrusted, revoked, source and bootstrap commits", () => {
    expect(isOwningCommit(agentCommit("a"), live)).toBe(true);
    expect(
      isOwningCommit({ ...agentCommit("a"), trustedAuthor: false }, live),
    ).toBe(false);
    expect(
      isOwningCommit({ ...agentCommit("a"), trustedAuthor: undefined }, live),
    ).toBe(false);
    expect(isOwningCommit(agentCommit("a"), new Set())).toBe(false);
    expect(
      isOwningCommit(
        { ...agentCommit("a"), operationId: `wiki-input:${RUN}` },
        live,
      ),
    ).toBe(false);
    expect(
      isOwningCommit(
        {
          ...agentCommit("a"),
          operationId: `wiki-bootstrap:${AGENT}:0001`,
          runId: null,
        },
        live,
      ),
    ).toBe(false);
  });
});

describe("decideOwnership", () => {
  const decide = (
    existing: { runId: string; lastAgentCommitSha: string } | null,
    history: Array<ReturnType<typeof agentCommit | typeof humanCommit>>,
    complete = true,
  ) => decideOwnership({ existing, history, complete, liveAgentIds: live });

  it("inserts for a page only agent run commits touched", () => {
    expect(decide(null, [agentCommit("b"), agentCommit("a")])).toEqual({
      action: "insert",
      runId: RUN,
      createdCommitSha: "a",
      lastAgentCommitSha: "b",
    });
  });

  it("advances on the next agent commit", () => {
    expect(
      decide({ runId: RUN, lastAgentCommitSha: "a" }, [
        agentCommit("b"),
        agentCommit("a"),
      ]),
    ).toEqual({ action: "advance", lastAgentCommitSha: "b" });
  });

  it("deletes on any other commit", () => {
    expect(
      decide({ runId: RUN, lastAgentCommitSha: "a" }, [
        humanCommit("b"),
        agentCommit("a"),
      ]),
    ).toEqual({ action: "delete" });
  });

  it("does not let an agent commit paper over a missed human commit", () => {
    expect(
      decide({ runId: RUN, lastAgentCommitSha: "a" }, [
        agentCommit("c"),
        humanCommit("b"),
        agentCommit("a"),
      ]),
    ).toEqual({ action: "delete" });
  });

  it("never owns an agent-patched human page or an unwalkable history", () => {
    expect(decide(null, [agentCommit("b"), humanCommit("a")])).toEqual({
      action: "keep",
    });
    expect(decide(null, [agentCommit("b")], false)).toEqual({ action: "keep" });
  });

  it("is idempotent when the head is already recorded", () => {
    expect(
      decide({ runId: RUN, lastAgentCommitSha: "a" }, [agentCommit("a")]),
    ).toEqual({ action: "keep" });
  });
});
