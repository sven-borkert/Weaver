import { describe, expect, it } from "vitest";
import {
  hasNoUser,
  machineIdentity,
  skipsLabelEnrichment,
  type ContentWriteActor,
} from "./contentAuthor";

const key: ContentWriteActor = {
  kind: "projectApiKey",
  projectId: "p",
  keyId: "k",
  name: "Key",
  email: "k@example.test",
};
const user = {
  userId: "u",
  name: "U",
  email: "u@example.test",
} as unknown as ContentWriteActor;

describe("content author predicates", () => {
  it("classifies a project API key and a user", () => {
    expect(hasNoUser(key)).toBe(true);
    expect(skipsLabelEnrichment(key)).toBe(true);
    expect(machineIdentity(key)).toEqual({
      machineKind: "projectApiKey",
      machineId: "k",
    });
    expect(hasNoUser(user)).toBe(false);
    expect(skipsLabelEnrichment(user)).toBe(false);
    expect(machineIdentity(user)).toBeNull();
  });
});
