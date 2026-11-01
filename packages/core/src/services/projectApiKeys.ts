import { randomUUID } from "node:crypto";
import { appPublicUrl, type PublicUrlEnv } from "@weaver/config/publicUrls";
import type {
  Prisma,
  PrismaClient,
  ProjectApiKey,
  ProjectApiKeyGrant,
} from "@weaver/db/client";
import type { ProjectRepoReader, ProjectRepoWriter } from "@weaver/git-store";
import { CoreError } from "../errors";
import type { SecurityContext } from "../security/context";
import type { TableColumn } from "../tables/types";
import { assertProjectRole } from "./projectAccess";
import { lockProjectMembershipWrites } from "./projectMembers";
import { withExistingProjectRepoReader, withProjectRepo } from "./projectRepo";
import { listScopeDirsAt } from "./folders";
import { generateProjectMachineToken } from "../projectApi/credentials";
import {
  ensureFolderIdentityInRepo,
  loadFolderIdentityIndex,
} from "../projectApi/folderIdentity";
import {
  readMachineDocumentSnapshot,
  readMachineTableSchema,
  resourceIdentityIndex,
} from "../projectApi/snapshots";
import {
  createProjectApiKeyInput,
  projectApiTargetInput,
  updateProjectApiKeyInput,
  type CreateProjectApiKeyInput,
  type GrantInput,
  type ProjectApiTargetInput,
  type UpdateProjectApiKeyInput,
} from "../projectApi/schemas";
import {
  MACHINE_ACTIONS,
  PROJECT_API_DEFAULT_EXPIRY_DAYS,
  PROJECT_API_MAX_KEYS,
} from "../projectApi/constants";
import type { MachineTargetKind, StoredGrant } from "../projectApi/types";
import {
  decodeMachineCursor,
  encodeMachineCursor,
} from "../projectApi/cursors";

type Db = PrismaClient | Prisma.TransactionClient;
type KeyRow = ProjectApiKey & { grants: ProjectApiKeyGrant[] };

export type ProjectApiGrantSummary = StoredGrant & {
  available: boolean;
  label: string;
  location: string;
  /** Configured columns of a table grant, for copyable row examples. */
  columns?: TableColumn[];
};
export type ProjectApiKeySummary = {
  id: string;
  projectId: string;
  name: string;
  fingerprint: string;
  status: "Active" | "Expired" | "Revoked";
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  policyVersion: number;
  rateLimitPerMinute: number;
  grants: ProjectApiGrantSummary[];
};
export type ProjectApiGrantTarget = {
  kind: MachineTargetKind;
  targetId?: string;
  root?: true;
  /** Legacy folder without a persistent identity; assigned when granted. */
  path?: string[];
  label: string;
  location: string;
  columns?: TableColumn[];
};
export type ProjectApiGrantTargetPage = {
  items: ProjectApiGrantTarget[];
  nextCursor: string | null;
};
export type ProjectApiUnresolvedOperation = {
  id: string;
  keyId: string;
  operation: string;
  createdAt: Date;
  reason: string;
};

const ACTION_COLUMNS = {
  read: "canRead",
  create: "canCreate",
  update: "canUpdate",
  delete: "canDelete",
} as const;
const DAY_MS = 86_400_000;
// Grants may assign legacy folder identities (a Git commit) inside the policy transaction.
const POLICY_TRANSACTION = { maxWait: 10_000, timeout: 60_000 } as const;

const isFolderKind = (kind: MachineTargetKind) =>
  kind === "documentFolder" || kind === "tableFolder";
const scopeOf = (kind: MachineTargetKind) =>
  kind.startsWith("document") ? ("documents" as const) : ("tables" as const);
const rootTarget = (kind: MachineTargetKind) =>
  kind === "documentFolder"
    ? { label: "Documents root", location: "" }
    : { label: "Tables root", location: "tables" };
const grantKey = (grant: Pick<StoredGrant, "kind" | "targetId" | "root">) =>
  `${grant.kind}:${grant.root ? "root" : grant.targetId}`;

function storedGrant(row: ProjectApiKeyGrant): StoredGrant {
  return {
    kind: row.targetKind,
    targetId: row.targetId,
    root: row.isScopeRoot,
    actions: MACHINE_ACTIONS.filter((action) => row[ACTION_COLUMNS[action]]),
  };
}

async function assertKeyManager(
  db: Db,
  actor: SecurityContext,
  projectId: string,
) {
  if (actor.authenticationMethod !== "session")
    throw new CoreError("FORBIDDEN", "A signed-in session is required");
  await assertProjectRole(db, projectId, actor, "Maintainer", {
    capability: "content:write",
  });
}

function parseInput<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[] }[] } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const field = result.error.issues[0]?.path[0];
  throw new CoreError("BAD_REQUEST", "Invalid project key policy", {
    field: typeof field === "string" ? field : "grants",
  });
}

/** Committed title and location of a grant target, or null when its identity is unavailable. */
async function describeTarget(
  db: Db,
  repo: ProjectRepoReader | null,
  projectId: string,
  grant: Pick<StoredGrant, "kind" | "targetId" | "root">,
): Promise<{
  label: string;
  location: string;
  columns?: TableColumn[];
} | null> {
  if (grant.root) return rootTarget(grant.kind);
  if (!repo || !grant.targetId) return null;
  try {
    if (isFolderKind(grant.kind)) {
      const index = await loadFolderIdentityIndex(
        repo,
        projectId,
        scopeOf(grant.kind),
        await repo.resolveHead(),
      );
      const entry = index.byId.get(grant.targetId);
      if (!entry) return null;
      const location = entry.path.join("/");
      return { label: location, location };
    }
    const snapshot =
      grant.kind === "document"
        ? await readMachineDocumentSnapshot(db, repo, projectId, grant.targetId)
        : await readMachineTableSchema(db, repo, projectId, grant.targetId);
    return {
      label: snapshot.title,
      location: snapshot.path,
      ...("columns" in snapshot ? { columns: snapshot.columns } : {}),
    };
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

async function summarize(
  db: Db,
  repo: ProjectRepoReader | null,
  row: KeyRow,
  now = new Date(),
): Promise<ProjectApiKeySummary> {
  const grants: ProjectApiGrantSummary[] = [];
  for (const grant of row.grants.map(storedGrant)) {
    const described = await describeTarget(db, repo, row.projectId, grant);
    grants.push({
      ...grant,
      available: described !== null,
      label: described?.label ?? "Unavailable target",
      location: described?.location ?? "",
      ...(described?.columns ? { columns: described.columns } : {}),
    });
  }
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    fingerprint: row.fingerprint,
    status: row.revokedAt
      ? "Revoked"
      : row.expiresAt && row.expiresAt <= now
        ? "Expired"
        : "Active",
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    policyVersion: row.policyVersion,
    rateLimitPerMinute: row.rateLimitPerMinute,
    grants,
  };
}

/** Validates grants against committed identities and merges duplicate targets. */
async function normalizeGrants(
  tx: Prisma.TransactionClient,
  repo: ProjectRepoWriter,
  actor: SecurityContext,
  projectId: string,
  input: GrantInput[],
  prior: ProjectApiKeyGrant[] = [],
) {
  const merged = new Map<string, StoredGrant>();
  const priorKeys = new Set(prior.map((row) => grantKey(storedGrant(row))));
  for (const grant of input) {
    let targetId = grant.targetId ?? null;
    if (grant.path) {
      const user = await tx.user.findUnique({
        where: { id: actor.userId },
        select: { name: true, email: true },
      });
      if (!user) throw new CoreError("FORBIDDEN");
      try {
        targetId = (
          await ensureFolderIdentityInRepo(
            repo,
            scopeOf(grant.kind),
            grant.path,
            {
              ...actor,
              name: user.name,
              email: user.email,
            },
          )
        ).id;
      } catch (error) {
        if (
          error instanceof CoreError &&
          (error.code === "NOT_FOUND" || error.code === "PRECONDITION_FAILED")
        )
          throw new CoreError("BAD_REQUEST", "Grant folder is unavailable", {
            field: "grants",
          });
        throw error;
      }
    }
    const candidate: StoredGrant = {
      kind: grant.kind,
      targetId,
      root: grant.root === true,
      actions: grant.actions,
    };
    const key = grantKey(candidate);
    if (
      !priorKeys.has(key) &&
      !(await describeTarget(tx, repo, projectId, candidate))
    )
      throw new CoreError("BAD_REQUEST", "Grant target is unavailable", {
        field: "grants",
      });
    const existing = merged.get(key);
    merged.set(key, {
      ...candidate,
      actions: MACHINE_ACTIONS.filter(
        (action) =>
          candidate.actions.includes(action) ||
          existing?.actions.includes(action),
      ),
    });
  }
  return [...merged.values()].map((grant) => ({
    targetKind: grant.kind,
    targetId: grant.targetId,
    isScopeRoot: grant.root,
    canRead: grant.actions.includes("read"),
    canCreate: grant.actions.includes("create"),
    canUpdate: grant.actions.includes("update"),
    canDelete: grant.actions.includes("delete"),
  }));
}

const expiryFrom = (now: Date, days: number | null) =>
  days === null ? null : new Date(now.getTime() + days * DAY_MS);

/** Runs a policy change under the project lock, then membership-write serialization. */
function withKeyPolicyLock<T>(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
  fn: (tx: Prisma.TransactionClient, repo: ProjectRepoWriter) => Promise<T>,
): Promise<T> {
  return withProjectRepo(projectId, (repo) =>
    db.$transaction(async (tx) => {
      await lockProjectMembershipWrites(tx, projectId);
      await assertKeyManager(tx, actor, projectId);
      return fn(tx, repo);
    }, POLICY_TRANSACTION),
  );
}

export async function listProjectApiKeys(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
): Promise<ProjectApiKeySummary[]> {
  await assertKeyManager(db, actor, projectId);
  const load = async (repo: ProjectRepoReader | null) => {
    await assertKeyManager(db, actor, projectId);
    const rows = await db.projectApiKey.findMany({
      where: { projectId },
      include: { grants: { orderBy: { id: "asc" } } },
      orderBy: [
        { revokedAt: { sort: "desc", nulls: "first" } },
        { createdAt: "desc" },
      ],
      take: PROJECT_API_MAX_KEYS * 2,
    });
    const summaries: ProjectApiKeySummary[] = [];
    for (const row of rows) summaries.push(await summarize(db, repo, row));
    return summaries;
  };
  return (await withExistingProjectRepoReader(projectId, load)) ?? load(null);
}

export async function createProjectApiKey(
  db: PrismaClient,
  actor: SecurityContext,
  raw: CreateProjectApiKeyInput,
): Promise<{ key: ProjectApiKeySummary; secret: string }> {
  const input = parseInput(createProjectApiKeyInput, raw);
  await assertKeyManager(db, actor, input.projectId);
  const id = randomUUID();
  const token = generateProjectMachineToken(id);
  return withKeyPolicyLock(db, actor, input.projectId, async (tx, repo) => {
    const active = await tx.projectApiKey.count({
      where: { projectId: input.projectId, revokedAt: null },
    });
    if (active >= PROJECT_API_MAX_KEYS)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "Revoke an existing key before creating another",
      );
    const grants = await normalizeGrants(
      tx,
      repo,
      actor,
      input.projectId,
      input.grants,
    );
    const now = new Date();
    const row = await tx.projectApiKey.create({
      data: {
        id,
        projectId: input.projectId,
        createdById: actor.userId,
        name: input.name,
        digest: token.digest,
        fingerprint: token.fingerprint,
        rateLimitPerMinute: input.rateLimitPerMinute,
        createdAt: now,
        expiresAt: expiryFrom(
          now,
          input.expiresInDays === undefined
            ? PROJECT_API_DEFAULT_EXPIRY_DAYS
            : input.expiresInDays,
        ),
        grants: { create: grants },
      },
      include: { grants: { orderBy: { id: "asc" } } },
    });
    return { key: await summarize(tx, repo, row, now), secret: token.secret };
  });
}

export async function updateProjectApiKey(
  db: PrismaClient,
  actor: SecurityContext,
  raw: UpdateProjectApiKeyInput,
): Promise<ProjectApiKeySummary> {
  const input = parseInput(updateProjectApiKeyInput, raw);
  await assertKeyManager(db, actor, input.projectId);
  return withKeyPolicyLock(db, actor, input.projectId, async (tx, repo) => {
    const existing = await tx.projectApiKey.findFirst({
      where: { id: input.keyId, projectId: input.projectId },
      include: { grants: true },
    });
    if (!existing) throw new CoreError("NOT_FOUND");
    if (existing.revokedAt)
      throw new CoreError("PRECONDITION_FAILED", "Revoked keys cannot change");
    const grants = await normalizeGrants(
      tx,
      repo,
      actor,
      input.projectId,
      input.grants,
      existing.grants,
    );
    const now = new Date();
    const row = await tx.projectApiKey.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        rateLimitPerMinute: input.rateLimitPerMinute,
        policyVersion: { increment: 1 },
        ...(input.expiresInDays === undefined
          ? {}
          : { expiresAt: expiryFrom(now, input.expiresInDays) }),
        grants: { deleteMany: {}, create: grants },
      },
      include: { grants: { orderBy: { id: "asc" } } },
    });
    return summarize(tx, repo, row, now);
  });
}

export async function revokeProjectApiKey(
  db: PrismaClient,
  actor: SecurityContext,
  input: { projectId: string; keyId: string },
): Promise<void> {
  await assertKeyManager(db, actor, input.projectId);
  await withKeyPolicyLock(db, actor, input.projectId, async (tx) => {
    const existing = await tx.projectApiKey.findFirst({
      where: { id: input.keyId, projectId: input.projectId },
      select: { id: true, revokedAt: true },
    });
    if (!existing) throw new CoreError("NOT_FOUND");
    if (existing.revokedAt) return;
    await tx.projectApiKey.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), policyVersion: { increment: 1 } },
    });
  });
}

/** Read-only, paginated grant picker; legacy folders are offered by path and receive an identity only when granted. */
export async function listProjectApiGrantTargets(
  db: PrismaClient,
  actor: SecurityContext,
  raw: ProjectApiTargetInput,
): Promise<ProjectApiGrantTargetPage> {
  const input = projectApiTargetInput.parse(raw);
  await assertKeyManager(db, actor, input.projectId);
  const page = await withExistingProjectRepoReader(
    input.projectId,
    async (repo) => {
      await assertKeyManager(db, actor, input.projectId);
      const head = await repo.resolveHead();
      const binding = JSON.stringify([
        "grant-targets",
        actor.userId,
        input.projectId,
        input.kind,
        input.limit,
        input.search ?? "",
        head,
      ]);
      const offset = input.cursor
        ? Number(decodeMachineCursor(input.cursor, binding))
        : 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new CoreError("BAD_REQUEST", "Invalid cursor");
      const candidates: ProjectApiGrantTarget[] = [];
      if (isFolderKind(input.kind)) {
        const scope = scopeOf(input.kind);
        candidates.push({
          kind: input.kind,
          root: true,
          ...rootTarget(input.kind),
        });
        const index = await loadFolderIdentityIndex(
          repo,
          input.projectId,
          scope,
          head,
        );
        const byPath = new Map(index.entries.map((e) => [e.path.join("/"), e]));
        const locations = (await listScopeDirsAt(repo, scope, head))
          .filter(Boolean)
          .sort();
        for (const location of locations) {
          const entry = byPath.get(location);
          candidates.push({
            kind: input.kind,
            ...(entry ? { targetId: entry.id } : { path: location.split("/") }),
            label: location,
            location,
          });
        }
      } else {
        const kind = input.kind === "document" ? "document" : "table";
        const identities = await resourceIdentityIndex(
          repo,
          input.projectId,
          kind,
          head,
        );
        const ids = [...identities.keys()];
        const titles = new Map(
          (kind === "document"
            ? await db.document.findMany({
                where: { projectId: input.projectId, id: { in: ids } },
                select: { id: true, title: true },
              })
            : await db.dataTable.findMany({
                where: { projectId: input.projectId, id: { in: ids } },
                select: { id: true, title: true },
              })
          ).map((row) => [row.id, row.title]),
        );
        const items = [...identities].map(([id, location]) => ({
          kind: input.kind,
          targetId: id,
          label: titles.get(id) ?? location.split("/").at(-1) ?? location,
          location,
        }));
        items.sort(
          (a, b) =>
            a.label.localeCompare(b.label) ||
            (a.targetId < b.targetId ? -1 : 1),
        );
        candidates.push(...items);
      }
      const search = input.search?.trim().toLowerCase();
      const matching = search
        ? candidates.filter(
            (t) =>
              t.label.toLowerCase().includes(search) ||
              t.location.toLowerCase().includes(search),
          )
        : candidates;
      const items = matching.slice(offset, offset + input.limit);
      for (const target of items)
        if (target.kind === "table" && target.targetId)
          target.columns = (
            await readMachineTableSchema(
              db,
              repo,
              input.projectId,
              target.targetId,
            )
          ).columns;
      const next = offset + items.length;
      return {
        items,
        nextCursor:
          next < matching.length
            ? encodeMachineCursor(binding, String(next))
            : null,
      };
    },
  );
  if (page) return page;
  return {
    items: isFolderKind(input.kind)
      ? [{ kind: input.kind, root: true, ...rootTarget(input.kind) }]
      : [],
    nextCursor: null,
  };
}

export async function projectApiConfiguration(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
  env: PublicUrlEnv,
): Promise<{ baseUrl: string }> {
  await assertKeyManager(db, actor, projectId);
  return { baseUrl: appPublicUrl(env) };
}

/** Oldest reservations without a settled receipt, for manual investigation only. */
export async function listUnresolvedProjectApiOperations(
  db: PrismaClient,
  actor: SecurityContext,
  projectId: string,
): Promise<ProjectApiUnresolvedOperation[]> {
  await assertKeyManager(db, actor, projectId);
  const rows = await db.projectApiOperation.findMany({
    where: { projectId, state: "reserved" },
    select: { id: true, keyId: true, operation: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  return rows.map((row) => ({
    ...row,
    reason: "The outcome of this write has not been confirmed",
  }));
}
