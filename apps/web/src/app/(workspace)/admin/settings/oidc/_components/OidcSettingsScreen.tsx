"use client";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { OidcSettingsForm } from "./OidcSettingsForm";

export function OidcSettingsScreen() {
  const utils = api.useUtils();
  const query = api.oidc.getSettings.useQuery();
  const settings = dataUnlessAccessError(query.data, query.error);
  if (settings)
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {query.error ? (
          <p role="alert" className="text-danger text-[13px]">
            Could not refresh OIDC settings. Your draft is preserved.{" "}
            <Button variant="link" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </p>
        ) : null}
        <OidcSettingsForm
          settings={settings}
          onSaved={(saved) => utils.oidc.getSettings.setData(undefined, saved)}
        />
      </div>
    );
  if (query.isLoading) return <Skeleton className="h-72 w-full rounded-xl" />;
  return (
    <div
      role="alert"
      className="text-danger flex flex-col items-start gap-3 text-[13px]"
    >
      Could not load OIDC settings.
      <Button variant="outline" onClick={() => void query.refetch()}>
        Retry
      </Button>
    </div>
  );
}
