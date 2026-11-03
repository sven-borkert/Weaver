import { beforeEach, describe, expect, it } from "vitest";
import { wikiSaveTarget } from "@weaver/core/services/wikiSaveTarget";
import {
  disableWiki,
  getWikiSettings,
} from "@weaver/core/services/wikiSettings";
import {
  addMembership,
  makeProject,
  makeUser,
  resetDb,
  securityContextFor,
  getPrisma,
} from "./_harness";
import { wikiProject } from "./_wikiRunHarness";

describe("Save as page target", () => {
  beforeEach(resetDb, 60_000);

  it("is the folder holding the recorded sources folder while the wiki is enabled", async () => {
    const p = await wikiProject();
    expect(
      await wikiSaveTarget(p.db, p.security, { projectId: p.projectId }),
    ).toEqual({ enabled: true, folderPath: ["wiki"] });
    const view = await getWikiSettings(p.db, p.security, p.projectId);
    await disableWiki(p.db, p.security, {
      projectId: p.projectId,
      expectedRevision: view.revision,
    });
    expect(
      await wikiSaveTarget(p.db, p.security, { projectId: p.projectId }),
    ).toEqual({ enabled: false, folderPath: null });
  }, 60_000);

  it("offers no default for a project without a wiki and refuses a Viewer", async () => {
    const db = getPrisma();
    const owner = await makeUser("User", "save-owner");
    const viewer = await makeUser("User", "save-viewer");
    const project = await makeProject("No wiki");
    await addMembership(project.id, owner.id, "Owner");
    await addMembership(project.id, viewer.id, "Viewer");
    expect(
      await wikiSaveTarget(db, securityContextFor(owner), {
        projectId: project.id,
      }),
    ).toEqual({ enabled: false, folderPath: null });
    await expect(
      wikiSaveTarget(db, securityContextFor(viewer), {
        projectId: project.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});
