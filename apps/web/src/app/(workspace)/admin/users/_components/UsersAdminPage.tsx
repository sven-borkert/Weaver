"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ClientDate } from "~/components/ui/client-date";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
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
  dataUnlessAccessError,
  resolveQueryPresentation,
} from "~/lib/query-presentation";
import { api, type RouterOutputs } from "~/trpc/react";
import { CreateUserDialog } from "./CreateUserDialog";

type UserRow = RouterOutputs["user"]["list"]["users"][number];

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

/** Presentational — takes `users` as a prop so it renders without tRPC. */
export function UsersTable({ users }: { users: UserRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last sign-in</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="text-text text-[13px] font-medium">
              <Link
                href={`/admin/users/${user.id}`}
                className="hover:underline"
              >
                {user.name}
              </Link>
            </TableCell>
            <TableCell className="text-text-2 text-[13px]">
              {user.email}
            </TableCell>
            <TableCell className="text-text-2 text-[13px]">
              {user.role}
            </TableCell>
            <TableCell>
              {user.active ? (
                <Badge variant="secondary">Active</Badge>
              ) : (
                <Badge
                  variant="destructive"
                  title={user.banReason ?? undefined}
                >
                  Deactivated
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-text-3 text-[12px]">
              {user.lastLoginAt ? (
                <ClientDate value={user.lastLoginAt} />
              ) : (
                "Never"
              )}
            </TableCell>
            <TableCell className="text-text-3 text-[12px]">
              <ClientDate value={user.createdAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function UsersAdminPage() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearch(rawSearch.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [rawSearch]);

  const listQuery = api.user.list.useInfiniteQuery(
    { search: search || undefined, limit: PAGE_SIZE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const data = dataUnlessAccessError(listQuery.data, listQuery.error);
  const presentation = resolveQueryPresentation({
    data,
    error: listQuery.error,
    isLoading: listQuery.isLoading,
  });
  const users = data?.pages.flatMap((page) => page.users) ?? [];

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-text m-0 text-[20px] font-semibold">Users</h1>
          <p className="text-text-3 m-0 text-[13px]">
            Create accounts, change global roles, and manage access. Deactivate
            an account instead of deleting it — user deletion is not offered.
          </p>
        </div>
        <CreateUserDialog />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="user-search">Search users</Label>
        <Input
          id="user-search"
          type="search"
          placeholder="Search by name or email"
          value={rawSearch}
          onChange={(event) => setRawSearch(event.target.value)}
          className="max-w-sm"
        />
      </div>

      {presentation === "loading" ? (
        <div className="flex flex-col gap-2 py-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : presentation === "error" || !data ? (
        <p className="text-danger m-0 text-[13px]">Could not load users.</p>
      ) : users.length === 0 ? (
        <p className="text-text-3 m-0 text-[13px]">
          {search ? "No users match your search." : "No users yet."}
        </p>
      ) : (
        <>
          <UsersTable users={users} />
          {listQuery.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              disabled={listQuery.isFetchingNextPage}
              onClick={() => void listQuery.fetchNextPage()}
            >
              {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
