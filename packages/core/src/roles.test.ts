import { describe, expect, it } from "vitest";
import { CoreError } from "./errors";
import {
  fromOrganizationRole,
  PROJECT_ROLE_RANK,
  projectRoleAtLeast,
  toOrganizationRole,
} from "./roles";

describe("projectRoleAtLeast", () => {
  it("orders Owner > Maintainer > Editor > Viewer", () => {
    expect(PROJECT_ROLE_RANK.Owner).toBeGreaterThan(
      PROJECT_ROLE_RANK.Maintainer,
    );
    expect(PROJECT_ROLE_RANK.Maintainer).toBeGreaterThan(
      PROJECT_ROLE_RANK.Editor,
    );
    expect(PROJECT_ROLE_RANK.Editor).toBeGreaterThan(PROJECT_ROLE_RANK.Viewer);
  });

  it("compares inclusively", () => {
    expect(projectRoleAtLeast("Editor", "Editor")).toBe(true);
    expect(projectRoleAtLeast("Editor", "Maintainer")).toBe(false);
    expect(projectRoleAtLeast("Owner", "Viewer")).toBe(true);
  });
});

describe("organization role mapping", () => {
  it("maps Weaver roles to Better Auth member roles one-to-one", () => {
    expect(toOrganizationRole("Owner")).toBe("owner");
    expect(toOrganizationRole("Maintainer")).toBe("maintainer");
    expect(toOrganizationRole("Editor")).toBe("editor");
    expect(toOrganizationRole("Viewer")).toBe("viewer");
    expect(fromOrganizationRole("maintainer")).toBe("Maintainer");
  });

  it("rejects member roles Weaver does not define", () => {
    let error: unknown;
    try {
      fromOrganizationRole("member");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("INTERNAL_SERVER_ERROR");
    expect((error as CoreError).message).toBe(
      "Unknown organization member role: member",
    );
  });
});
