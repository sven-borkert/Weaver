import { describe, expect, it } from "vitest";
import {
  readConversation,
  readOpen,
  writeConversation,
  writeOpen,
} from "./panelState";

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("panel state", () => {
  it("defaults closed and round-trips open state", () => {
    const s = storage();
    expect(readOpen(s)).toBe(false);
    writeOpen(s, true);
    expect(readOpen(s)).toBe(true);
  });
  it("round-trips the conversation id and clears it", () => {
    const s = storage();
    expect(readConversation(s)).toBeNull();
    writeConversation(s, "11111111-1111-4111-8111-111111111111");
    expect(readConversation(s)).toBe("11111111-1111-4111-8111-111111111111");
    writeConversation(s, null);
    expect(readConversation(s)).toBeNull();
  });
  it("swallows storage exceptions", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readOpen(throwing)).toBe(false);
    expect(readConversation(throwing)).toBeNull();
    expect(() => writeOpen(throwing, true)).not.toThrow();
  });
});

it("isolates stored conversations by principal and ignores legacy identityless entries", () => {
  const s = storage();
  s.setItem("weaver:assistant:conversation", "legacy-private");
  expect(readConversation(s, "b")).toBeNull();
  writeConversation(s, "a-private", "a");
  expect(readConversation(s, "b")).toBeNull();
  expect(readConversation(s, "a")).toBe("a-private");
});
