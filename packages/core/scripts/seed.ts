import { createCredentialUser, createWeaverAuth } from "@weaver/auth";
import { Role } from "@weaver/db/client";
import { db } from "@weaver/db";
import { ORGANIZATION_ROLE_BY_PROJECT_ROLE as ORGANIZATION_ROLE } from "../src/roles";
import { createSessionSecurityContext } from "../src/security/context";
import { createProject } from "../src/services/projects";
import { syncProjectMetadata } from "../src/services/projectMetadata";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set — run the seed through pnpm db:seed or pnpm db:e2e:seed",
  );
}
const secret = process.env.AUTH_SECRET;
if (!secret) {
  throw new Error(
    "AUTH_SECRET is not set — the seed hashes passwords through Better Auth",
  );
}
const auth = createWeaverAuth({
  db,
  secret,
  baseURL: process.env.AUTH_URL ?? "http://localhost:3000",
});

const PASSWORD = "admin1234567";
async function ensureUser(key: string, name: string, role: Role = Role.User) {
  const { id } = await createCredentialUser(auth, {
    email: `${key}@weaver.local`,
    password: PASSWORD,
    name,
    role,
  });
  return id;
}

async function main() {
  const users = {
    admin: await ensureUser("admin", "Admin", Role.Admin),
    owner: await ensureUser("owner", "Olivia Owner"),
    maintainer: await ensureUser("maintainer", "Max Maintainer"),
    editor: await ensureUser("editor", "Emma Editor"),
    viewer: await ensureUser("viewer", "Victor Viewer"),
    trainer: await ensureUser("trainer", "Tina Trainer"),
    trainee: await ensureUser("trainee", "Theo Trainee"),
  };

  // A soft-deleted Demo Project stays deleted; a fresh one is created instead.
  const existing = await db.project.findFirst({
    where: { name: "Demo Project", deletedAt: null },
  });
  const ownerActor = createSessionSecurityContext({
    userId: users.owner,
    globalRole: "User",
    sessionId: "seed",
  });
  const project =
    existing ??
    (await createProject(db, ownerActor, {
      name: "Demo Project",
      description: "Seeded demo project exercising all four membership roles.",
    }));

  const memberships = [
    { userId: users.owner, role: ORGANIZATION_ROLE.Owner },
    { userId: users.maintainer, role: ORGANIZATION_ROLE.Maintainer },
    { userId: users.editor, role: ORGANIZATION_ROLE.Editor },
    { userId: users.viewer, role: ORGANIZATION_ROLE.Viewer },
    { userId: users.trainer, role: ORGANIZATION_ROLE.Editor },
    { userId: users.trainee, role: ORGANIZATION_ROLE.Viewer },
  ];
  for (const { userId, role } of memberships) {
    await db.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: project.organizationId,
          userId,
        },
      },
      update: { role },
      create: { organizationId: project.organizationId, userId, role },
    });
  }

  for (const [userId, role] of [
    [users.trainer, "trainer"],
    [users.trainee, "trainee"],
  ] as const) {
    await db.projectTrainingRole.upsert({
      where: { projectId_userId: { projectId: project.id, userId } },
      create: {
        projectId: project.id,
        userId,
        role,
        assignedById: users.owner,
      },
      update: { role },
    });
  }
  await syncProjectMetadata(db, project.id, ownerActor);

  // Spec §6.2: the seeded admin owns any otherwise orphaned project.
  const orphaned = await db.project.findMany({
    where: {
      deletedAt: null,
      organization: {
        members: { none: { role: ORGANIZATION_ROLE.Owner } },
      },
    },
    select: { id: true, name: true, organizationId: true },
  });
  for (const orphan of orphaned) {
    await db.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: orphan.organizationId,
          userId: users.admin,
        },
      },
      update: { role: ORGANIZATION_ROLE.Owner },
      create: {
        organizationId: orphan.organizationId,
        userId: users.admin,
        role: ORGANIZATION_ROLE.Owner,
      },
    });
    await syncProjectMetadata(
      db,
      orphan.id,
      createSessionSecurityContext({
        userId: users.admin,
        globalRole: "Admin",
        sessionId: "seed",
      }),
    );
    console.log(
      "Assigned admin@weaver.local as Owner of orphaned project %s",
      orphan.name,
    );
  }

  console.log(
    "Seed complete. Logins (password %s): admin@weaver.local, owner@weaver.local, maintainer@weaver.local, editor@weaver.local, viewer@weaver.local, trainer@weaver.local, trainee@weaver.local",
    PASSWORD,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
