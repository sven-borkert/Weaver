"use client";

import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { Fragment } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Skeleton } from "~/components/ui/skeleton";
import { formatItemLocation } from "~/lib/copy-location";
import { parseFolderParam } from "~/lib/documents/explorer";
import { folderDisplayName, folderHref } from "~/lib/explorer/entries";
import { tablesBase } from "~/lib/tables/explorer";
import { api } from "~/trpc/react";
import { CopyLocationButton } from "./CopyLocationButton";
import { DocumentsBreadcrumbs } from "./DocumentsBreadcrumbs";

/** The table's folder segments: its path minus the `tables/` root and the trailing `<slug>.table` leaf. */
function tableFolderSegments(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .replace(/^tables\//, "")
    .split("/")
    .slice(0, -1)
    .filter(Boolean);
}

type FolderNames = Parameters<typeof folderDisplayName>[0];

/** Display names of each folder prefix; null until the folder tree that names them has loaded. */
function folderNamesFor(
  path: string[],
  folderNames: FolderNames,
): string[] | null {
  if (path.length === 0) return [];
  if (!folderNames) return null;
  return path.map((_, index) =>
    folderDisplayName(folderNames, path.slice(0, index + 1)),
  );
}

function BreadcrumbSkeleton() {
  return <Skeleton className="h-4 w-36" />;
}

/** Leading project link on project routes; global routes start at their own section. */
function ProjectCrumb() {
  const { projectId } = useParams<{ projectId?: string }>();
  const projectQuery = api.project.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId) },
  );
  const project = cachedDataUnlessAccessFailed(
    projectQuery.data,
    projectQuery.error,
  );
  if (!projectId || !project) return null;
  return (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink asChild>
          <Link href={`/projects/${projectId}`} className="max-w-56 truncate">
            {project.name}
          </Link>
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
    </>
  );
}

function cachedDataUnlessAccessFailed<T>(
  data: T | undefined,
  error: unknown,
): T | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return data;
  const errorData = error.data;
  if (!errorData || typeof errorData !== "object" || !("code" in errorData)) {
    return data;
  }
  return ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"].includes(
    typeof errorData.code === "string" ? errorData.code : "",
  )
    ? undefined
    : data;
}

export function WorkspaceBreadcrumbs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const folderFromQuery = parseFolderParam(
    searchParams.get("folder") ?? undefined,
  );
  const { projectId, documentId, tableId, conversationId, fileId, userId } =
    useParams<{
      projectId?: string;
      documentId?: string;
      tableId?: string;
      conversationId?: string;
      fileId?: string;
      userId?: string;
    }>();
  const projectQuery = api.project.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId) },
  );
  const documentQuery = api.document.get.useQuery(
    { projectId: projectId ?? "", documentId: documentId ?? "" },
    { enabled: Boolean(projectId && documentId) },
  );
  const tableFolderTreeQuery = api.tableFolder.tree.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId && tableId) },
  );
  const documentFolderTreeQuery = api.folder.tree.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId && documentId) },
  );
  const tableQuery = api.table.get.useQuery(
    { projectId: projectId ?? "", tableId: tableId ?? "" },
    { enabled: Boolean(projectId && tableId) },
  );
  const conversationQuery = api.assistant.getConversation.useQuery(
    { conversationId: conversationId ?? "" },
    { enabled: Boolean(conversationId) },
  );
  const importFileQuery = api.ingestion.getFile.useQuery(
    { fileId: fileId ?? "" },
    { enabled: Boolean(fileId && /^[0-9a-f-]{36}$/.test(fileId)) },
  );
  const userDetailQuery = api.user.get.useQuery(
    { userId: userId ?? "" },
    { enabled: Boolean(userId) },
  );
  const project = cachedDataUnlessAccessFailed(
    projectQuery.data,
    projectQuery.error,
  );
  const document = cachedDataUnlessAccessFailed(
    documentQuery.data,
    documentQuery.error,
  );
  const table = cachedDataUnlessAccessFailed(tableQuery.data, tableQuery.error);
  const conversation = cachedDataUnlessAccessFailed(
    conversationQuery.data,
    conversationQuery.error,
  );

  if (pathname === "/assistant" || conversationId) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            {conversationId ? (
              <BreadcrumbLink asChild>
                <Link href="/assistant">Assistant</Link>
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>Assistant</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {conversationId && conversation ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{conversation.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/reviews" || pathname === "/reviews/recent") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <span className="text-text-2">Reviews</span>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              {pathname === "/reviews" ? "Open" : "Recently reviewed"}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/account/password") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Account</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Password</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/account/api-keys") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Account</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>API keys</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/account/tasks") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Account</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Tasks</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/account/background-work") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Account</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Background work</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/account/connected-apps") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Account</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Connected apps</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/account/remote-instances") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Account</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Remote instances</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname.startsWith("/admin/settings")) {
    const leaf = pathname.endsWith("/remote-instances")
      ? "Remote instances"
      : pathname.endsWith("/oidc")
        ? "OIDC"
        : "AI";
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <span className="text-text-2">Administration</span>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/admin/settings">Settings</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{leaf}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/admin/ai") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Administration</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>AI</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname.startsWith("/account/connections")) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Account</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {pathname === "/account/connections" ? (
              <BreadcrumbPage>MCP connections</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild>
                <Link href="/account/connections">MCP connections</Link>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {pathname !== "/account/connections" ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Connection details</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/admin/remote-instances") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <span className="text-text-2">Administration</span>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Remote instances</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/admin/diagnostics") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Administration</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Diagnostics</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname.startsWith("/admin/projects")) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <span className="text-text-2">Administration</span>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {pathname === "/admin/projects" ? (
              <BreadcrumbPage>Projects</BreadcrumbPage>
            ) : (
              <BreadcrumbLink asChild>
                <Link href="/admin/projects">Projects</Link>
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {pathname !== "/admin/projects" ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Project details</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === "/admin/users") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Administration</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Users</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (userId && pathname === `/admin/users/${userId}`) {
    if (userDetailQuery.isLoading) {
      return (
        <Breadcrumb>
          <BreadcrumbList>
            <ProjectCrumb />
            <BreadcrumbItem>
              <BreadcrumbPage>Administration</BreadcrumbPage>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/admin/users">Users</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbSkeleton />
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      );
    }
    const targetUser = cachedDataUnlessAccessFailed(
      userDetailQuery.data,
      userDetailQuery.error,
    );
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Administration</BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/admin/users">Users</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{targetUser?.name ?? "User"}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (
    projectQuery.isLoading ||
    (documentId && documentQuery.isLoading) ||
    (tableId && tableQuery.isLoading)
  ) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbSkeleton />
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (!project) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>Weaver</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === `/projects/${projectId}/activity`) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Activity</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  const settingsRoute = pathname === `/projects/${projectId}/settings`;
  const tablesHref = `/projects/${projectId}/tables`;
  const graphHref = `/projects/${projectId}/graph`;
  const importsHref = `/projects/${projectId}/imports`;
  const examsHref = `/projects/${projectId}/exams`;
  if (pathname === examsHref || pathname.startsWith(`${examsHref}/`)) {
    return <ExamBreadcrumb projectId={projectId ?? ""} pathname={pathname} />;
  }
  const tasksHref = `/projects/${projectId}/tasks`;

  if (pathname === graphHref) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Graph</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === tasksHref || pathname.startsWith(`${tasksHref}/`)) {
    const detail = pathname !== tasksHref;
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            {detail ? (
              <BreadcrumbLink asChild>
                <Link href={tasksHref}>Tasks</Link>
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>Tasks</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {detail ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Task</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === `/projects/${projectId}/wiki`) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Wiki</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === importsHref) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Imports</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (fileId && pathname.startsWith(`${importsHref}/`)) {
    const importFile = cachedDataUnlessAccessFailed(
      importFileQuery.data,
      importFileQuery.error,
    );
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={importsHref}>Imports</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              {importFile && importFile.projectId === projectId
                ? importFile.fileName
                : "Review"}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (pathname === tablesHref || tableId) {
    const folderSegments = tableFolderSegments(table?.path);
    const tableFolderNames = folderNamesFor(
      folderSegments,
      tableFolderTreeQuery.data?.folderNames,
    );
    const tableLocation =
      project && table && tableId && tableFolderNames
        ? formatItemLocation({
            projectName: project.name,
            projectId: projectId ?? "",
            folder: tableFolderNames,
            kind: "Table",
            title: table.title,
            itemId: tableId,
          })
        : null;
    return (
      <div className="flex min-w-0 items-center gap-1">
        <Breadcrumb>
          <BreadcrumbList>
            <ProjectCrumb />
            <BreadcrumbItem>
              {tableId ? (
                <BreadcrumbLink asChild>
                  <Link href={tablesHref}>Tables</Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>Tables</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {tableId
              ? folderSegments.map((_, index) => (
                  <Fragment key={folderSegments.slice(0, index + 1).join("/")}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbLink asChild>
                        <Link
                          href={folderHref(
                            tablesBase(projectId ?? ""),
                            folderSegments.slice(0, index + 1),
                          )}
                        >
                          {folderDisplayName(
                            tableFolderTreeQuery.data?.folderNames,
                            folderSegments.slice(0, index + 1),
                          )}
                        </Link>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                  </Fragment>
                ))
              : null}
            {tableId ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{table?.title ?? "Table"}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
        {tableId ? (
          <CopyLocationButton
            text={tableLocation}
            label="Copy table location"
          />
        ) : null}
      </div>
    );
  }

  if (settingsRoute) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <BreadcrumbItem>
            <BreadcrumbPage>Settings</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  const documentFolder = document
    ? document.path.split("/").slice(0, -1)
    : folderFromQuery;
  const documentFolderNames = document
    ? folderNamesFor(documentFolder, documentFolderTreeQuery.data?.folderNames)
    : null;
  const documentLocation =
    project && document && documentId && documentFolderNames
      ? formatItemLocation({
          projectName: project.name,
          projectId: projectId ?? "",
          folder: documentFolderNames,
          kind: "Document",
          title: document.title,
          itemId: documentId,
        })
      : null;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Breadcrumb>
        <BreadcrumbList>
          <ProjectCrumb />
          <DocumentsBreadcrumbs
            projectId={projectId ?? ""}
            folderPath={documentFolder}
            current={
              document && documentId
                ? { kind: "document", id: documentId, title: document.title }
                : { kind: "folder" }
            }
          />
        </BreadcrumbList>
      </Breadcrumb>
      {documentId ? (
        <CopyLocationButton
          text={documentLocation}
          label="Copy document location"
        />
      ) : null}
    </div>
  );
}

function ExamBreadcrumb({
  projectId,
  pathname,
}: {
  projectId: string;
  pathname: string;
}) {
  const base = `/projects/${projectId}/exams`;
  const detail = pathname !== base;
  const attempt = pathname.startsWith(`${base}/attempts/`);
  const results = pathname === `${base}/results`;
  const id =
    detail && !attempt && !results ? pathname.slice(base.length + 1) : "";
  const q = api.exam.get.useQuery({ examId: id }, { enabled: Boolean(id) });
  const exam = cachedDataUnlessAccessFailed(q.data, q.error);
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <ProjectCrumb />
        <BreadcrumbItem>
          {detail ? (
            <BreadcrumbLink asChild>
              <Link href={base}>Exams</Link>
            </BreadcrumbLink>
          ) : (
            <BreadcrumbPage>Exams</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {detail ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>
                {results
                  ? "Results"
                  : attempt
                    ? "Attempt"
                    : (exam?.title ?? "Exam")}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
