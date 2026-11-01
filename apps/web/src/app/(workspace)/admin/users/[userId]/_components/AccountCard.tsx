"use client";

import { GLOBAL_ROLES } from "@weaver/core/services/userSchemas";

import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { RouterOutputs } from "~/trpc/react";

type UserDetail = RouterOutputs["user"]["get"];
type GlobalRole = UserDetail["role"];

/** Presentational — takes plain props so it renders without tRPC. */
export function AccountCard({
  name,
  email,
  role,
  active,
  banReason,
  isSelf,
  onChangeRole,
  rolePending,
}: {
  name: string;
  email: string;
  role: GlobalRole;
  active: boolean;
  banReason: string | null;
  isSelf: boolean;
  onChangeRole: (role: GlobalRole) => void;
  rolePending: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          Name and email are managed outside Weaver; only the global role is
          editable here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Name</Label>
          <p className="text-text m-0 text-[13px]">{name}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Email</Label>
          <p className="text-text m-0 text-[13px]">{email}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-role">Global role</Label>
          <Select
            value={role}
            disabled={isSelf || rolePending}
            onValueChange={(value) => onChangeRole(value as GlobalRole)}
          >
            <SelectTrigger id="account-role" className="w-full max-w-[220px]">
              <SelectValue>{role}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {GLOBAL_ROLES.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isSelf ? (
            <p className="text-text-3 m-0 text-[12px]">
              You cannot change your own global role.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Status</Label>
          <div>
            {active ? (
              <Badge variant="secondary">Active</Badge>
            ) : (
              <Badge variant="destructive" title={banReason ?? undefined}>
                Deactivated
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
