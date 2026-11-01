import { expect, it } from "vitest";
import { createProjectInput, updateProjectInput } from "./project";
import { addMemberInput } from "./projectMember";
import { listUsersInput } from "@weaver/core/services/userSchemas";
const id = "00000000-0000-4000-8000-000000000001";
it("rejects oversized user cursors", () =>
  expect(listUsersInput.safeParse({ cursor: "a".repeat(2049) }).success).toBe(
    false,
  ));
it.each(["bad\nname", "bad\u0000name", "bad\u007fname"])(
  "rejects project control characters",
  (name) => {
    expect(createProjectInput.safeParse({ name }).success).toBe(false);
    expect(updateProjectInput.safeParse({ projectId: id, name }).success).toBe(
      false,
    );
  },
);
it("trims pasted member emails before validation", () =>
  expect(
    addMemberInput.parse({
      projectId: id,
      email: " Bob@example.com ",
      role: "Viewer",
    }).email,
  ).toBe("bob@example.com"));
