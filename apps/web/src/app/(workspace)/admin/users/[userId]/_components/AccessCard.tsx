"use client";

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@weaver/core/services/userSchemas";
import { Ban, KeyRound, LogOut, RefreshCw, UserCheck } from "lucide-react";
import { useState } from "react";

import { RevealPasswordDialog } from "~/app/(workspace)/admin/users/_components/RevealPasswordDialog";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { generatePassword } from "~/lib/users/generatePassword";
import { useCloseOnSettle } from "./useCloseOnSettle";

/** Presentational — takes plain props and callbacks so it renders without tRPC. */
export function AccessCard({
  email,
  active,
  banReason,
  isSelf,
  onDeactivate,
  deactivatePending,
  onReactivate,
  reactivatePending,
  onResetPassword,
  resetPasswordPending,
  revealedPassword,
  onCloseReveal,
  onRevokeSessions,
  revokeSessionsPending,
}: {
  email: string;
  active: boolean;
  banReason: string | null;
  isSelf: boolean;
  onDeactivate: (reason: string) => void;
  deactivatePending: boolean;
  onReactivate: () => void;
  reactivatePending: boolean;
  onResetPassword: (password: string) => void;
  resetPasswordPending: boolean;
  revealedPassword: string | null;
  onCloseReveal: () => void;
  onRevokeSessions: () => void;
  revokeSessionsPending: boolean;
}) {
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [revokeOpen, setRevokeOpen] = useState(false);

  useCloseOnSettle(deactivatePending, () => setDeactivateOpen(false));
  useCloseOnSettle(resetPasswordPending, () => {
    setResetOpen(false);
    // The typed/generated plaintext must not outlive this dialog either —
    // it becomes the account's real password on success, so it gets the
    // same "no lingering copy" treatment as the RevealPasswordDialog value.
    setPassword("");
  });
  useCloseOnSettle(revokeSessionsPending, () => setRevokeOpen(false));

  const reasonValid = reason.trim().length > 0;
  const passwordValid =
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Access</CardTitle>
          <CardDescription>
            Deactivate, reset the password, or sign this account out everywhere.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {active ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isSelf || deactivatePending}
                onClick={() => {
                  setReason("");
                  setDeactivateOpen(true);
                }}
              >
                <Ban data-icon="inline-start" />
                Deactivate
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reactivatePending}
                onClick={onReactivate}
              >
                <UserCheck data-icon="inline-start" />
                {reactivatePending ? "Reactivating…" : "Reactivate"}
              </Button>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSelf || resetPasswordPending}
              onClick={() => {
                setPassword("");
                setResetOpen(true);
              }}
            >
              <KeyRound data-icon="inline-start" />
              Reset password
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={revokeSessionsPending}
              onClick={() => setRevokeOpen(true)}
            >
              <LogOut data-icon="inline-start" />
              Revoke sessions
            </Button>
          </div>

          {!active ? (
            <p className="text-text-3 m-0 text-[12px]">
              Deactivated{banReason ? `: ${banReason}` : ""}.
            </p>
          ) : null}
          {isSelf ? (
            <p className="text-text-3 m-0 text-[12px]">
              You cannot deactivate your own account. Change your own password
              from Account settings.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={deactivateOpen}
        onOpenChange={(nextOpen) => {
          if (deactivatePending) return;
          setDeactivateOpen(nextOpen);
        }}
      >
        <DialogContent aria-busy={deactivatePending || undefined}>
          <DialogHeader>
            <DialogTitle>Deactivate account</DialogTitle>
            <DialogDescription>
              {email} will lose access immediately. Give a reason for the
              record.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="deactivate-reason">Reason</Label>
            <Textarea
              id="deactivate-reason"
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deactivatePending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={!reasonValid || deactivatePending}
              onClick={() => onDeactivate(reason.trim())}
            >
              {deactivatePending ? "Deactivating…" : "Deactivate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetOpen}
        onOpenChange={(nextOpen) => {
          if (resetPasswordPending) return;
          setResetOpen(nextOpen);
          // Cancel, Escape, and an overlay click all report a close here —
          // not just a settled mutation — so the typed/generated plaintext
          // must not survive any of them either.
          if (!nextOpen) setPassword("");
        }}
      >
        <DialogContent aria-busy={resetPasswordPending || undefined}>
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Resets {email}&apos;s password and signs them out everywhere.
              Their API keys and connected apps are revoked and stay revoked
              after they change the password. The password is shown once — share
              it through a secure channel.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="reset-password-value">New password</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPassword(generatePassword(20))}
              >
                <RefreshCw data-icon="inline-start" />
                Generate
              </Button>
            </div>
            <Input
              id="reset-password-value"
              type="text"
              autoComplete="off"
              className="font-mono text-[12px]"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {!passwordValid && password.length > 0 ? (
              <p className="text-danger text-[12px]">
                Must be at least {PASSWORD_MIN_LENGTH} characters
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={resetPasswordPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={!passwordValid || resetPasswordPending}
              onClick={() => onResetPassword(password)}
            >
              {resetPasswordPending ? "Resetting…" : "Reset password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeOpen}
        onOpenChange={(nextOpen) => {
          if (revokeSessionsPending) return;
          setRevokeOpen(nextOpen);
        }}
      >
        <DialogContent aria-busy={revokeSessionsPending || undefined}>
          <DialogHeader>
            <DialogTitle>Revoke sessions</DialogTitle>
            <DialogDescription>
              Sign {email} out of every active session immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={revokeSessionsPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={revokeSessionsPending}
              onClick={onRevokeSessions}
            >
              {revokeSessionsPending ? "Revoking…" : "Revoke sessions"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RevealPasswordDialog
        password={revealedPassword}
        title="Copy the reset password"
        description="This is the only time this password is shown. Share it with the user through a secure channel — they must change it before doing anything else."
        onClose={onCloseReveal}
      />
    </>
  );
}
