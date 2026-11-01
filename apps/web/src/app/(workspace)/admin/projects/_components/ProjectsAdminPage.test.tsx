import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectsTable } from "./ProjectsAdminPage";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Demo Project",
  createdAt: new Date("2026-09-04T08:48:06Z"),
  isPersonal: false,
  memberCount: 4,
  owners: [
    {
      userId: "22222222-2222-4222-8222-222222222222",
      name: "Owner Person",
      email: "owner@weaver.local",
    },
  ],
  documentCount: 0,
  tableCount: 0,
  callerIsMember: false,
};

describe("ProjectsTable", () => {
  it("links each project to its admin detail page with owners and counts", () => {
    const html = renderToStaticMarkup(<ProjectsTable projects={[base]} />);
    expect(html).toContain(
      'href="/admin/projects/11111111-1111-4111-8111-111111111111"',
    );
    expect(html).toContain("Demo Project");
    expect(html).toContain("Owner Person");
    expect(html).toContain(">4<");
    expect(html).not.toContain("Member</");
  });

  it("badges personal projects and projects the admin belongs to", () => {
    const html = renderToStaticMarkup(
      <ProjectsTable
        projects={[{ ...base, isPersonal: true, callerIsMember: true }]}
      />,
    );
    expect(html).toContain("Personal");
    expect(html).toContain("Member");
  });

  it("says when a project has no owner", () => {
    const html = renderToStaticMarkup(
      <ProjectsTable projects={[{ ...base, owners: [] }]} />,
    );
    expect(html).toContain("No owner");
  });
});
