"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { ClientDate } from "~/components/ui/client-date";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { withBasePath } from "~/lib/basePath";
import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { DisconnectRemoteDialog } from "./DisconnectRemoteDialog";
import type { callbackNotice } from "./callbackNotice";

type RemoteRow = RouterOutputs["remoteInstance"]["listForUser"][number];

function ConnectButton({ remote }: { remote: RemoteRow }) {
  const connect = api.remoteInstance.connect.useMutation({
    onSuccess: ({ authorizeUrl }) => {
      window.location.assign(authorizeUrl);
    },
    onError: (err) => {
      toast.error(err.message || "Could not start the connection");
    },
  });

  return (
    <Button
      size="sm"
      disabled={connect.isPending}
      aria-busy={connect.isPending || undefined}
      onClick={() => connect.mutate({ remoteInstanceId: remote.id })}
    >
      {connect.isPending ? "Connecting…" : "Connect"}
    </Button>
  );
}

export function RemoteInstancesCard({
  notice,
}: {
  notice: ReturnType<typeof callbackNotice>;
}) {
  const cardFocusRef = useRef<HTMLDivElement>(null);
  const remotesQuery = api.remoteInstance.listForUser.useQuery();

  useEffect(() => {
    if (!notice) return;
    if (notice.kind === "success") toast.success(notice.message);
    else toast.error(notice.message);
    // Clear the callback query so a refresh does not re-fire the notice.
    window.history.replaceState(
      null,
      "",
      withBasePath("/account/remote-instances"),
    );
  }, [notice]);

  return (
    <Card
      ref={cardFocusRef}
      role="region"
      aria-label="Remote instances"
      tabIndex={-1}
    >
      <CardHeader>
        <CardTitle>Remote instances</CardTitle>
        <CardDescription>
          Connect your account to other Weaver instances to send documents and
          tables there.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {remotesQuery.isLoading ? (
          <div className="flex flex-col gap-2 py-1">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : remotesQuery.error ? (
          <p className="text-danger m-0 text-[13px]">
            Could not load remote instances.
          </p>
        ) : (remotesQuery.data ?? []).length === 0 ? (
          <p className="text-text-3 m-0 text-[13px]">
            No remote instances are registered. Ask an administrator to add one.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-32">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(remotesQuery.data ?? []).map((remote) => (
                <TableRow key={remote.id}>
                  <TableCell className="text-text text-[13px] font-medium">
                    {remote.name}
                    <span className="text-text-3 block text-[12px]">
                      {remote.baseUrl}
                    </span>
                  </TableCell>
                  <TableCell className="text-text-3 text-[12px]">
                    {remote.connection ? (
                      <>
                        Connected as {remote.connection.remoteUserName ?? "you"}
                        <span className="block">
                          <ClientDate value={remote.connection.connectedAt} />
                        </span>
                      </>
                    ) : (
                      "Not connected"
                    )}
                  </TableCell>
                  <TableCell>
                    {remote.connection ? (
                      <DisconnectRemoteDialog
                        remoteInstanceId={remote.id}
                        name={remote.name}
                        fallbackFocusRef={cardFocusRef}
                      />
                    ) : (
                      <ConnectButton remote={remote} />
                    )}
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
