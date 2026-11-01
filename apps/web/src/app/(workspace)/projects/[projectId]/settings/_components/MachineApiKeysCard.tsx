"use client";

import { useRef } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { ClientDateTime } from "~/components/ui/client-date";
import { Skeleton } from "~/components/ui/skeleton";
import {
  MACHINE_ACTION_LABELS,
  MACHINE_TARGET_KIND_LABELS,
} from "~/lib/project-api/policy";
import {
  dataUnlessAccessError,
  isQueryAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api, type RouterOutputs } from "~/trpc/react";
import { MachineApiKeyDialog } from "./MachineApiKeyDialog";
import { MachineKeyExamples } from "./MachineKeySecretDialog";
import { RevokeMachineApiKeyDialog } from "./RevokeMachineApiKeyDialog";

type KeySummary = RouterOutputs["projectApiKey"]["list"][number];

const STATUS_VARIANTS = {
  Active: "default",
  Expired: "secondary",
  Revoked: "outline",
} as const;

/** Rendered only for members who may manage keys; nothing is queried otherwise. */
export function MachineApiKeysCard({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  return canManage ? (
    <AuthorizedMachineApiKeysCard key={projectId} projectId={projectId} />
  ) : null;
}

function GrantList({ grants }: { grants: KeySummary["grants"] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {grants.map((grant) => (
        <li
          key={`${grant.kind}:${grant.root ? "root" : grant.targetId}`}
          className="text-text-2 text-[12px]"
        >
          <span className="text-text font-medium">{grant.label}</span>
          {" · "}
          {MACHINE_TARGET_KIND_LABELS[grant.kind]}
          {grant.kind.endsWith("Folder")
            ? " with subfolders and future content"
            : ""}
          {" · "}
          {grant.actions.map((a) => MACHINE_ACTION_LABELS[a]).join(", ")}
          {grant.available ? null : (
            <span className="text-danger"> · unavailable</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function AuthorizedMachineApiKeysCard({ projectId }: { projectId: string }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const keysQuery = api.projectApiKey.list.useQuery({ projectId });
  const configuration = api.projectApiKey.configuration.useQuery({
    projectId,
  });
  const unresolvedQuery = api.projectApiKey.unresolvedOperations.useQuery({
    projectId,
  });
  if (isQueryAccessError(keysQuery.error)) return null;
  const presentation = resolveQueryPresentation(keysQuery);
  const keys = dataUnlessAccessError(keysQuery.data, keysQuery.error);
  const baseUrl = configuration.data?.baseUrl ?? null;
  const unresolved = unresolvedQuery.data ?? [];

  return (
    <Card
      ref={cardRef}
      role="region"
      aria-label="Project API keys"
      tabIndex={-1}
    >
      <CardHeader>
        <CardTitle>Project API keys</CardTitle>
        <CardDescription>
          Let scripts publish reports to chosen documents and tables. Keys
          belong to the project and are independent of any member.
        </CardDescription>
        <CardAction>
          <MachineApiKeyDialog projectId={projectId} baseUrl={baseUrl} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {unresolved.length > 0 ? (
          <div
            role="status"
            className="border-border flex flex-col gap-1 rounded-lg border p-3"
          >
            <p className="text-text m-0 text-[13px] font-medium">
              Writes awaiting confirmation
            </p>
            <p className="text-text-3 m-0 text-[12px]">
              Weaver could not confirm whether these requests were saved. They
              are never retried automatically; compare them with the project
              history before the client retries.
            </p>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {unresolved.map((operation) => (
                <li key={operation.id} className="text-text-2 text-[12px]">
                  {operation.operation} · operation {operation.id} · key{" "}
                  {keys?.find((key) => key.id === operation.keyId)?.name ??
                    operation.keyId}{" "}
                  · <ClientDateTime value={operation.createdAt} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {presentation === "loading" ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : presentation === "error" ? (
          <div role="alert" className="text-text-2 text-[13px]">
            Could not load project API keys.{" "}
            <Button
              size="sm"
              variant="outline"
              disabled={keysQuery.isFetching}
              onClick={() => void keysQuery.refetch()}
            >
              {keysQuery.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : keys?.length ? (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {keys.map((key) => (
              <li
                key={key.id}
                className="border-border flex flex-col gap-2 rounded-lg border p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-text text-[13px] font-medium break-words">
                        {key.name}
                      </span>
                      <Badge variant={STATUS_VARIANTS[key.status]}>
                        {key.status}
                      </Badge>
                    </div>
                    <span className="text-text-3 text-[12px]">
                      Fingerprint {key.fingerprint} · {key.rateLimitPerMinute}{" "}
                      requests per minute
                    </span>
                    <span className="text-text-3 text-[12px]">
                      {key.revokedAt ? (
                        <>
                          Revoked <ClientDateTime value={key.revokedAt} />
                        </>
                      ) : key.expiresAt ? (
                        <>
                          {key.status === "Expired" ? "Expired" : "Expires"}{" "}
                          <ClientDateTime value={key.expiresAt} />
                        </>
                      ) : (
                        "Never expires"
                      )}
                      {" · Last used "}
                      {key.lastUsedAt ? (
                        <ClientDateTime value={key.lastUsedAt} />
                      ) : (
                        "never"
                      )}
                    </span>
                  </div>
                  {key.revokedAt ? null : (
                    <div className="flex gap-2">
                      <MachineApiKeyDialog
                        key={key.id}
                        projectId={projectId}
                        baseUrl={baseUrl}
                        existing={key}
                      />
                      <RevokeMachineApiKeyDialog
                        projectId={projectId}
                        keyId={key.id}
                        name={key.name}
                        fingerprint={key.fingerprint}
                        focusFallback={() => cardRef.current}
                      />
                    </div>
                  )}
                </div>
                <GrantList grants={key.grants} />
                {baseUrl && key.status === "Active" ? (
                  <details>
                    <summary className="text-text-2 cursor-pointer text-[12px]">
                      Publishing examples
                    </summary>
                    <div className="pt-2">
                      <MachineKeyExamples
                        baseUrl={baseUrl}
                        projectId={projectId}
                        grants={key.grants}
                      />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-text-3 m-0 text-[13px]">
            No project API keys yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
