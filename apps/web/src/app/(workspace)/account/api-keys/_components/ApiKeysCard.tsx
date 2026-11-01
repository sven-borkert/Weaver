"use client";

import { useRef } from "react";

import { Button } from "~/components/ui/button";
import { ClientDate } from "~/components/ui/client-date";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { api, type RouterOutputs } from "~/trpc/react";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";
import { EditApiKeyDialog } from "./EditApiKeyDialog";
import { RevokeApiKeyDialog } from "./RevokeApiKeyDialog";

type ApiKeyRow = RouterOutputs["apiKey"]["list"][number];

const CAPABILITY_LABEL: Record<string, string> = {
  "mcp:use": "MCP",
  "content:read": "Read",
  "content:propose": "Propose",
  "content:write": "Write",
  "system:admin": "Admin",
  "ingest:external": "Import",
  "external:use": "External",
  "external:manage": "Connections",
};

export function ApiKeysCard({ isAdmin }: { isAdmin: boolean }) {
  const cardFocusRef = useRef<HTMLDivElement>(null);
  const keysQuery = api.apiKey.list.useQuery();
  const projectsQuery = api.project.list.useQuery();
  const projectName = (id: string) =>
    projectsQuery.data?.find((project) => project.id === id)?.name ??
    (projectsQuery.error
      ? "Could not load project"
      : projectsQuery.isPending
        ? "Loading project…"
        : "Unavailable project");

  return (
    <Card
      ref={cardFocusRef}
      role="region"
      aria-label="Personal API keys"
      tabIndex={-1}
    >
      <CardHeader>
        <CardTitle>Personal API keys</CardTitle>
        <CardDescription>
          Read access and MCP are always included; write access and project
          restrictions are explicit per key.
        </CardDescription>
        <CardAction>
          {projectsQuery.isSuccess && !projectsQuery.error ? (
            <CreateApiKeyDialog
              isAdmin={isAdmin}
              projects={projectsQuery.data}
            />
          ) : (
            <Button disabled>Create API key</Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        {projectsQuery.error ? (
          <p role="alert">
            Could not load project restrictions.{" "}
            <button type="button" onClick={() => void projectsQuery.refetch()}>
              Retry
            </button>
          </p>
        ) : null}
        {keysQuery.isLoading ? (
          <div className="flex flex-col gap-2 py-1">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : keysQuery.error ? (
          <p className="text-danger m-0 text-[13px]">
            Could not load your API keys.
          </p>
        ) : (keysQuery.data ?? []).length === 0 ? (
          <p className="text-text-3 m-0 text-[13px]">
            You have no API keys yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-20">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(keysQuery.data ?? []).map((key: ApiKeyRow) => (
                <TableRow key={key.id}>
                  <TableCell className="text-text text-[13px] font-medium">
                    {key.name}
                  </TableCell>
                  <TableCell>
                    <code className="text-text-2 text-[12px]">
                      {key.start ? `${key.start}…` : "wvr_…"}
                    </code>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {key.capabilities.map((capability) =>
                        capability === "system:admin" && !isAdmin ? (
                          <Tooltip key={capability}>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="outline"
                                className="text-text-3 border-dashed"
                                tabIndex={0}
                              >
                                {CAPABILITY_LABEL[capability] ?? capability}
                                <span className="sr-only">
                                  {" "}
                                  (inactive while you are not an Admin)
                                </span>
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              Inactive while you are not an Admin
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Badge
                            key={capability}
                            variant={
                              capability === "content:write"
                                ? "default"
                                : "secondary"
                            }
                          >
                            {CAPABILITY_LABEL[capability] ?? capability}
                          </Badge>
                        ),
                      )}
                      {key.rateLimitPerMinute ? (
                        <Badge variant="outline">
                          {key.rateLimitPerMinute}/min
                        </Badge>
                      ) : null}
                      {!key.enabled ? (
                        <Badge variant="destructive">Disabled</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-text-3 text-[12px]">
                    {key.projectIds.length === 0
                      ? "All your projects"
                      : key.projectIds.map(projectName).join(", ")}
                  </TableCell>
                  <TableCell className="text-text-3 text-[12px]">
                    {key.expiresAt ? (
                      <ClientDate value={key.expiresAt} />
                    ) : (
                      "Never"
                    )}
                  </TableCell>
                  <TableCell className="text-text-3 text-[12px]">
                    {key.lastUsedAt ? (
                      <ClientDate value={key.lastUsedAt} />
                    ) : (
                      "Never"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <EditApiKeyDialog
                        apiKey={key}
                        isAdmin={isAdmin}
                        projects={projectsQuery.data ?? []}
                        fallbackFocusRef={cardFocusRef}
                        projectsReady={
                          projectsQuery.isSuccess && !projectsQuery.error
                        }
                        projectsError={Boolean(projectsQuery.error)}
                        retryProjects={() => void projectsQuery.refetch()}
                      />
                      <RevokeApiKeyDialog
                        keyId={key.id}
                        keyName={key.name}
                        fallbackFocusRef={cardFocusRef}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
