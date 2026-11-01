import type {
  BackgroundWorkItem,
  WorkAudience,
} from "@weaver/core/jobs/backgroundWorkSchema";
import Link from "next/link";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { backgroundWorkHref } from "~/lib/background-work/destination";
import { workStatusLabel } from "~/lib/background-work/presentation";

export function ActiveWorkCard({
  projectId,
  audience,
  items,
  loading,
  error,
  retry,
}: {
  projectId: string;
  audience: WorkAudience;
  items: BackgroundWorkItem[] | undefined;
  loading: boolean;
  error: unknown;
  retry: () => void;
}) {
  const href = `/account/background-work?${new URLSearchParams({ audience, projectId })}`;
  return (
    <Card role="region" aria-label="Active work">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle>
          <h2>Active work</h2>
        </CardTitle>
        <Link href={href} className="text-brand text-sm hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <div role="alert" className="text-text-3 text-sm">
            <p>
              Active work is unavailable.
              {items ? " Displayed results may be out of date." : ""}
            </p>
            <Button variant="outline" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : null}
        {loading && !items ? (
          <p role="status" className="text-text-3 text-sm">
            Loading active work…
          </p>
        ) : null}
        {items?.length ? (
          <ul className="divide-line divide-y">
            {items.map((item) => (
              <li
                key={`${item.kind}:${item.id}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <Link
                  href={backgroundWorkHref(item.destination)}
                  className="text-text truncate text-sm hover:underline"
                >
                  {item.title}
                </Link>
                <Badge variant="outline">{workStatusLabel(item)}</Badge>
              </li>
            ))}
          </ul>
        ) : items ? (
          <p className="text-text-3 text-sm">No active work.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
