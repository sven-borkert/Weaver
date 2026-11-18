import type {
  LocalDocumentEntryKind,
  Prisma,
  PrismaClient,
} from "@weaver/db/client";
import {
  MAX_FOLDER_NAME_LENGTH,
  normalizeFolderName,
} from "../documents/folderMetadata";
import { folderNotFound, MAX_FOLDER_DEPTH } from "../documents/paths";
import { assertPlainText, normalizeDocumentText } from "../documents/text";
import { documentTitleSchema } from "../documents/title";
import { parseDocumentBody, validateDocumentContent } from "../editor/markdown";
import { CoreError } from "../errors";
import { assertProjectRole, type ProjectActor } from "./projectAccess";

const MAX_LOCAL_ENTRIES = 10_000;

const summaryFields = {
  id: true,
  projectId: true,
  parentId: true,
  kind: true,
  title: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LocalDocumentEntrySelect;

const detailFields = {
  ...summaryFields,
  markdown: true,
} satisfies Prisma.LocalDocumentEntrySelect;

export type LocalDocumentEntrySummary = Prisma.LocalDocumentEntryGetPayload<{
  select: typeof summaryFields;
}>;
export type LocalDocumentEntry = Prisma.LocalDocumentEntryGetPayload<{
  select: typeof detailFields;
}>;

type ProjectInput = { projectId: string };
type EntryInput = ProjectInput & { id: string };
type RevisionInput = EntryInput & { expectedRevision: number };

function assertSession(actor: ProjectActor): void {
  if (actor.authenticationMethod !== "session") {
    throw new CoreError("FORBIDDEN");
  }
}

async function withLocalDocumentWrite<T>(
  db: PrismaClient,
  projectId: string,
  actor: ProjectActor,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertSession(actor);
  const {
    project: { id },
  } = await assertProjectRole(db, projectId, actor, "Editor");
  return db.$transaction(async (tx) => {
    // Serialize tree changes, including capacity checks and parent/child mutations.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`weaver:local-documents:${id}`}, 0))::text`;
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id}::uuid FOR SHARE`;
    await assertProjectRole(tx, id, actor, "Editor");
    return write(tx);
  });
}

function validateTitle(kind: LocalDocumentEntryKind, title: string): string {
  const field = { field: "title" };
  if (kind === "folder") {
    const name = normalizeFolderName(title);
    if (name === null) {
      throw new CoreError(
        "BAD_REQUEST",
        `Folder name must be a single line of 1 to ${MAX_FOLDER_NAME_LENGTH} characters`,
        field,
      );
    }
    return name;
  }
  const result = documentTitleSchema.safeParse(title);
  if (!result.success) {
    throw new CoreError(
      "BAD_REQUEST",
      result.error.issues[0]?.message ?? "Invalid document title",
      field,
    );
  }
  return result.data;
}

function validateMarkdown(
  kind: LocalDocumentEntryKind,
  markdown: string,
): string {
  const field = { field: "markdown" };
  if (kind === "folder") {
    throw new CoreError(
      "BAD_REQUEST",
      "Folders cannot contain Markdown",
      field,
    );
  }
  const body = normalizeDocumentText(markdown);
  assertPlainText(body, field.field);
  try {
    validateDocumentContent(parseDocumentBody(body));
  } catch {
    throw new CoreError("BAD_REQUEST", "Invalid document Markdown", field);
  }
  return body;
}

async function assertAvailableTitle(
  tx: Prisma.TransactionClient,
  projectId: string,
  parentId: string | null,
  title: string,
  currentId?: string,
): Promise<void> {
  const sibling = await tx.localDocumentEntry.findFirst({
    where: { projectId, parentId, title },
    select: { id: true },
  });
  if (sibling && sibling.id !== currentId) {
    throw new CoreError("CONFLICT", "This name is already used in the folder", {
      field: "title",
    });
  }
}

async function requireCurrentRevision(
  tx: Prisma.TransactionClient,
  { projectId, id, expectedRevision }: RevisionInput,
): Promise<LocalDocumentEntrySummary> {
  const entry = await tx.localDocumentEntry.findUnique({
    where: { projectId_id: { projectId, id } },
    select: summaryFields,
  });
  if (!entry) throw new CoreError("NOT_FOUND");
  if (entry.revision !== expectedRevision) {
    throw new CoreError(
      "CONFLICT",
      "This item changed. Reload it to continue.",
    );
  }
  return entry;
}

export async function listLocalDocumentEntries(
  db: PrismaClient,
  { projectId }: ProjectInput,
  actor: ProjectActor,
): Promise<LocalDocumentEntrySummary[]> {
  assertSession(actor);
  await assertProjectRole(db, projectId, actor, "Viewer");
  return db.localDocumentEntry.findMany({
    where: { projectId },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: MAX_LOCAL_ENTRIES,
    select: summaryFields,
  });
}

export async function getLocalDocumentEntry(
  db: PrismaClient,
  { projectId, id }: EntryInput,
  actor: ProjectActor,
): Promise<LocalDocumentEntry> {
  assertSession(actor);
  await assertProjectRole(db, projectId, actor, "Viewer");
  const entry = await db.localDocumentEntry.findUnique({
    where: { projectId_id: { projectId, id } },
    select: detailFields,
  });
  if (!entry) throw new CoreError("NOT_FOUND");
  return entry;
}

export async function createLocalDocumentEntry(
  db: PrismaClient,
  input: ProjectInput & {
    parentId?: string | null;
    kind: LocalDocumentEntryKind;
    title: string;
    markdown?: string;
  },
  actor: ProjectActor,
): Promise<LocalDocumentEntry> {
  const { projectId, parentId = null, kind } = input;
  return withLocalDocumentWrite(db, projectId, actor, async (tx) => {
    let folderDepth = kind === "folder" ? 1 : 0;
    if (parentId !== null) {
      const parent = await tx.localDocumentEntry.findUnique({
        where: { projectId_id: { projectId, id: parentId } },
        select: { kind: true, folderDepth: true },
      });
      if (!parent) throw folderNotFound("parentId");
      if (parent.kind !== "folder") {
        throw new CoreError("BAD_REQUEST", "Parent must be a folder", {
          field: "parentId",
        });
      }
      folderDepth += parent.folderDepth;
    }
    if (folderDepth > MAX_FOLDER_DEPTH) {
      throw new CoreError(
        "BAD_REQUEST",
        `Folder depth exceeds ${MAX_FOLDER_DEPTH}`,
        { field: "parentId" },
      );
    }
    const title = validateTitle(kind, input.title);
    await assertAvailableTitle(tx, projectId, parentId, title);
    if (
      (await tx.localDocumentEntry.count({ where: { projectId } })) >=
      MAX_LOCAL_ENTRIES
    ) {
      throw new CoreError(
        "PRECONDITION_FAILED",
        "This project has reached the Outside Git item limit",
      );
    }
    let markdown = kind === "document" ? "" : null;
    if (input.markdown !== undefined) {
      markdown = validateMarkdown(kind, input.markdown);
    }

    return tx.localDocumentEntry.create({
      data: { projectId, parentId, kind, title, markdown, folderDepth },
      select: detailFields,
    });
  });
}

export async function updateLocalDocumentEntry(
  db: PrismaClient,
  input: RevisionInput & { title?: string; markdown?: string },
  actor: ProjectActor,
): Promise<LocalDocumentEntry> {
  const { projectId, id } = input;
  return withLocalDocumentWrite(db, projectId, actor, async (tx) => {
    const entry = await requireCurrentRevision(tx, input);
    const data: Prisma.LocalDocumentEntryUpdateInput = {
      revision: { increment: 1 },
    };
    if (input.title !== undefined) {
      const title = validateTitle(entry.kind, input.title);
      await assertAvailableTitle(
        tx,
        projectId,
        entry.parentId,
        title,
        entry.id,
      );
      data.title = title;
    }
    if (input.markdown !== undefined) {
      data.markdown = validateMarkdown(entry.kind, input.markdown);
    }
    if (data.title === undefined && data.markdown === undefined) {
      throw new CoreError("BAD_REQUEST", "No changes to save");
    }
    return tx.localDocumentEntry.update({
      where: { projectId_id: { projectId, id } },
      data,
      select: detailFields,
    });
  });
}

export async function deleteLocalDocumentEntry(
  db: PrismaClient,
  input: RevisionInput,
  actor: ProjectActor,
): Promise<{ id: string }> {
  const { projectId, id } = input;
  return withLocalDocumentWrite(db, projectId, actor, async (tx) => {
    const entry = await requireCurrentRevision(tx, input);
    if (entry.kind === "folder") {
      const child = await tx.localDocumentEntry.findFirst({
        where: { projectId, parentId: id },
        select: { id: true },
      });
      if (child) {
        throw new CoreError("PRECONDITION_FAILED", "Folder is not empty");
      }
    }
    return tx.localDocumentEntry.delete({
      where: { projectId_id: { projectId, id } },
      select: { id: true },
    });
  });
}
