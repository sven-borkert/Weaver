"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@weaver/core/services/userSchemas";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";

/**
 * Client-side mirror of the server's account.changePassword input, plus a
 * confirmation field the server never sees.
 */
const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z
      .string()
      .min(
        PASSWORD_MIN_LENGTH,
        `Must be at least ${PASSWORD_MIN_LENGTH} characters`,
      )
      .max(
        PASSWORD_MAX_LENGTH,
        `Must be at most ${PASSWORD_MAX_LENGTH} characters`,
      ),
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type ChangePasswordFormValues = z.infer<typeof changePasswordFormSchema>;

const defaultValues: ChangePasswordFormValues = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

export function ChangePasswordCard({ forced = false }: { forced?: boolean }) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordFormSchema),
    defaultValues,
  });

  const changePassword = api.account.changePassword.useMutation({
    // The mutation's variables carry the user's plaintext current and new
    // passwords. gcTime: 0 evicts the mutation (and those variables) from
    // the QueryClient as soon as this observer detaches — reset() below
    // detaches it; gcTime: 0 makes that eviction near-immediate instead of
    // the 5-minute default, and also covers an unmount without ever
    // reaching onSuccess (e.g. navigating away mid-request).
    gcTime: 0,
    onSuccess: () => {
      toast.success("Password changed");
      reset(defaultValues);
      // Drops the mutation's cached variables so the plaintext passwords
      // don't linger in the mutation's own state after a successful change.
      changePassword.reset();
      // Forced mode has no other page to return to; ordinary mode leaves
      // the user on this page, matching every other account settings card.
      if (forced) router.replace("/");
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error(err.message || "Could not change the password");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    changePassword.mutate({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          Changing your password signs you out of every other session and
          revokes your API keys and connected-app grants.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {forced ? (
          <p
            role="status"
            className="border-info-border bg-info-bg text-info m-0 rounded-[6px] border px-3 py-2 text-[12px]"
          >
            An administrator set this password. You must change it before
            continuing.
          </p>
        ) : null}
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              aria-invalid={errors.currentPassword ? true : undefined}
              {...register("currentPassword")}
            />
            {errors.currentPassword ? (
              <p className="text-danger text-[12px]">
                {errors.currentPassword.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.newPassword ? true : undefined}
              {...register("newPassword")}
            />
            {errors.newPassword ? (
              <p className="text-danger text-[12px]">
                {errors.newPassword.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.confirmPassword ? true : undefined}
              {...register("confirmPassword")}
            />
            {errors.confirmPassword ? (
              <p className="text-danger text-[12px]">
                {errors.confirmPassword.message}
              </p>
            ) : null}
          </div>

          <div>
            <Button type="submit" disabled={changePassword.isPending}>
              {changePassword.isPending ? "Changing…" : "Change password"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
