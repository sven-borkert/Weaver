"use client";

import { useRef } from "react";

import { describeScope } from "~/app/(auth)/consent/scopeDescriptions";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { ClientDate } from "~/components/ui/client-date";
export { ClientDate } from "~/components/ui/client-date";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { api, type RouterOutputs } from "~/trpc/react";
import { RevokeConsentDialog } from "./RevokeConsentDialog";

type ConsentRow = RouterOutputs["oauthConsent"]["list"][number];

export function ConnectedAppsCard() {
  const cardFocusRef = useRef<HTMLDivElement>(null);
  const consentsQuery = api.oauthConsent.list.useQuery();

  return (
    <Card
      ref={cardFocusRef}
      role="region"
      aria-label="Connected apps"
      tabIndex={-1}
    >
      <CardHeader>
        <CardTitle>Connected apps</CardTitle>
        <CardDescription>
          Each entry is a client you approved on the consent screen, with the
          access it was granted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {consentsQuery.isLoading ? (
          <div className="flex flex-col gap-2 py-1">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : consentsQuery.error ? (
          <p className="text-danger m-0 text-[13px]">
            Could not load your connected apps.
          </p>
        ) : (consentsQuery.data ?? []).length === 0 ? (
          <p className="text-text-3 m-0 text-[13px]">No connected apps yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Allowed</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(consentsQuery.data ?? []).map((consent: ConsentRow) => {
                const name = consent.clientName ?? consent.clientId;
                return (
                  <TableRow key={consent.id}>
                    <TableCell className="text-text text-[13px] font-medium">
                      {name}
                      {consent.clientUri ? (
                        <span className="text-text-3 block text-[12px]">
                          {consent.clientUri}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {consent.scopes.map((scope) => {
                          const description = describeScope(scope);
                          return (
                            <Badge
                              key={scope}
                              variant={
                                description.write ? "default" : "secondary"
                              }
                            >
                              {description.title}
                            </Badge>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="text-text-3 text-[12px]">
                      {consent.createdAt ? (
                        <ClientDate value={consent.createdAt} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <RevokeConsentDialog
                        consentId={consent.id}
                        clientName={name}
                        fallbackFocusRef={cardFocusRef}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
