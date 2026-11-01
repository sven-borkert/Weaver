"use client";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api } from "~/trpc/react";
import { ConnectionsCard } from "./ConnectionsCard";
import { DocumentParsingCard } from "./DocumentParsingCard";
import { RoutesCard } from "./RoutesCard";

function AiAdminSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

export function AiAdminPage({ embedded = false }: { embedded?: boolean } = {}) {
  const Heading = embedded ? "h2" : "h1";
  const overviewQuery = api.llm.overview.useQuery();
  const overview = dataUnlessAccessError(
    overviewQuery.data,
    overviewQuery.error,
  );
  const presentation = resolveQueryPresentation({
    data: overview,
    error: overviewQuery.error,
    isLoading: overviewQuery.isLoading,
  });

  if (presentation === "loading") return <AiAdminSkeleton />;
  if (presentation === "error" || !overview) {
    return (
      <div className="border-danger-border bg-danger-bg flex w-full flex-col items-start gap-3 rounded-xl border p-5">
        <Heading className="text-text m-0 text-[20px] font-semibold">
          AI administration unavailable
        </Heading>
        <p className="text-danger m-0 text-[13px]">
          Could not load LLM connections and routes.
        </p>
        <Button variant="outline" onClick={() => void overviewQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Heading className="text-text m-0 text-[20px] font-semibold">
          AI
        </Heading>
        <p className="text-text-3 m-0 text-[13px]">
          Manage provider connections, declared models and the routes Weaver
          uses for AI work.
        </p>
        <p className="text-text-2 m-0 text-[12px]">
          Keys are encrypted at rest and never shown again.
        </p>
      </div>

      {!overview.encryptionConfigured ? (
        <p
          role="alert"
          className="border-danger-border bg-danger-bg text-danger m-0 rounded-lg border px-4 py-3 text-[13px]"
        >
          Encryption keys are not configured. Set WEAVER_ENCRYPTION_KEYS before
          adding connections.
        </p>
      ) : null}

      <ConnectionsCard
        encryptionConfigured={overview.encryptionConfigured}
        connections={overview.connections}
        routedEmbeddingModelId={
          overview.routes.find(
            (route) => route.purpose === "knowledge_embedding",
          )?.model?.modelId ?? null
        }
      />
      <RoutesCard connections={overview.connections} routes={overview.routes} />
      <DocumentParsingCard />
    </div>
  );
}
