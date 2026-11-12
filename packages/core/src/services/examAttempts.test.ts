import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@weaver/db/client";
import { createSessionSecurityContext } from "../security/context";
import { listAttempts } from "./examAttempts";

it("loads a page's users and projects in batches without parsing question snapshots", async () => {
  const trainee = {
    id: "trainee",
    name: "Trainee",
    email: "trainee@example.com",
  };
  const rows = ["one", "two"].map((id) => ({
    id,
    traineeId: trainee.id,
    projectId: "project",
    status: "released",
    startedAt: new Date(),
    definitionSnapshot: { title: "Snapshot title" },
  }));
  const userRead = vi.fn(async () => [trainee]);
  const projectRead = vi.fn(async () => [{ id: "project", name: "Project" }]);
  const db = {
    projectTrainingRole: { findMany: async () => [{ projectId: "project" }] },
    examAttempt: { findMany: async () => rows },
    user: {
      findMany: userRead,
      findUniqueOrThrow: async () => {
        throw new Error("Per-attempt user query");
      },
    },
    project: {
      findMany: projectRead,
      findUniqueOrThrow: async () => {
        throw new Error("Per-attempt project query");
      },
    },
  } as unknown as PrismaClient;
  const actor = createSessionSecurityContext({
    userId: "trainer",
    globalRole: "User",
    sessionId: "session",
  });
  const page = await listAttempts(db, actor, { projectIds: ["project"] });
  expect(
    page.items.map((item) => [
      item.id,
      item.examTitle,
      item.trainee,
      item.projectName,
    ]),
  ).toEqual(rows.map((row) => [row.id, "Snapshot title", trainee, "Project"]));
  expect(userRead).toHaveBeenCalledOnce();
  expect(projectRead).toHaveBeenCalledOnce();
});
