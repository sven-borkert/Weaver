import { describe, expect, it } from "vitest";

import {
  filterProjects,
  PROJECT_FILTER_THRESHOLD,
  projectSwitchDestination,
  type SwitchableProject,
} from "./project-switch";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";

describe("projectSwitchDestination", () => {
  it.each([
    ["documents", `/projects/${OLD}/documents?folder=a/b`],
    ["tables", `/projects/${OLD}/tables/33333333-3333-4333-8333-333333333333`],
    ["graph", `/projects/${OLD}/graph`],
    ["tasks", `/projects/${OLD}/tasks/44444444-4444-4444-8444-444444444444`],
    ["activity", `/projects/${OLD}/activity`],
    ["settings", `/projects/${OLD}/settings`],
  ])("keeps the %s section root", (section, pathname) => {
    expect(projectSwitchDestination(pathname, NEW, "Viewer")).toBe(
      `/projects/${NEW}/${section}`,
    );
  });

  it("keeps imports only for editors", () => {
    const pathname = `/projects/${OLD}/imports`;
    expect(projectSwitchDestination(pathname, NEW, "Editor")).toBe(
      `/projects/${NEW}/imports`,
    );
    expect(projectSwitchDestination(pathname, NEW, "Viewer")).toBe(
      `/projects/${NEW}/documents`,
    );
  });

  it.each([
    `/projects/${OLD}`,
    `/projects/${OLD}/documents/55555555-5555-4555-8555-555555555555`,
    "/admin/ai",
    "/assistant",
    "/account/password",
    "/admin/users",
  ])("falls back to documents from %s", (pathname) => {
    expect(projectSwitchDestination(pathname, NEW, "Owner")).toBe(
      `/projects/${NEW}/documents`,
    );
  });
});

const PROJECTS: SwitchableProject[] = [
  { id: "p1", name: "Alpha Project", myRole: "Owner" },
  { id: "p2", name: "beta project", myRole: "Editor" },
  { id: "p3", name: "Gamma", myRole: "Viewer" },
];

describe("filterProjects", () => {
  it("keeps every project in query order when the filter is blank or whitespace", () => {
    expect(filterProjects(PROJECTS, "")).toEqual(PROJECTS);
    expect(filterProjects(PROJECTS, "   ")).toEqual(PROJECTS);
  });

  it("matches case-insensitively on a name substring", () => {
    expect(filterProjects(PROJECTS, "PROJ")).toEqual([
      PROJECTS[0],
      PROJECTS[1],
    ]);
    expect(filterProjects(PROJECTS, "gamma")).toEqual([PROJECTS[2]]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterProjects(PROJECTS, "no such project")).toEqual([]);
  });

  it("sets the filter threshold to 8", () => {
    expect(PROJECT_FILTER_THRESHOLD).toBe(8);
  });
});
