"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  GLOBAL_ROLES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@weaver/core/services/userSchemas";
import { RefreshCw, UserPlus } from "lucide-react";
import { useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { generatePassword } from "~/lib/users/generatePassword";
import { api } from "~/trpc/react";
import { RevealPasswordContent } from "./RevealPasswordDialog";

/**
 * Client-side mirror of the server's user.create input, plus a confirmation
 * field the server never sees.
 */
const createUserFormSchema = z
  .object({
    email: z.email("Enter a valid email address").max(320),
    name: z.string().trim().min(1, "Name is required").max(200),
    role: z.enum(GLOBAL_ROLES),
    password: z
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
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type CreateUserFormValues = z.infer<typeof createUserFormSchema>;

const defaultValues: CreateUserFormValues = {
  email: "",
  name: "",
  role: "User",
  password: "",
  confirmPassword: "",
};

export function CreateUserDialog() {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  // Cleared on Done; never persisted to storage or logs.
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  // The admin has never seen a generated password, so only that one is revealed.
  const generatedPassword = useRef<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    setError,
    reset,
    setValue,
    formState: { errors },
  } = useForm<CreateUserFormValues>({
    resolver: zodResolver(createUserFormSchema),
    defaultValues,
  });

  const createUser = api.user.create.useMutation({
    // reset() detaches the secret result; gcTime: 0 evicts it immediately.
    gcTime: 0,
    onSuccess: (result) => {
      toast.success("User created");
      void utils.user.list.invalidate();
      const generated = result.password === generatedPassword.current;
      generatedPassword.current = null;
      reset(defaultValues);
      if (generated) setRevealedPassword(result.password);
      else {
        setOpen(false);
        createUser.reset();
      }
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error(err.message || "Could not create the user");
      }
    },
  });

  const onSubmit = handleSubmit(({ email, name, role, password }) => {
    createUser.mutate({ email, name, role, password });
  });

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (createUser.isPending || revealedPassword) return;
          setOpen(nextOpen);
          if (!nextOpen) {
            generatedPassword.current = null;
            reset(defaultValues);
          }
        }}
      >
        <DialogTrigger asChild>
          <Button size="sm">
            <UserPlus data-icon="inline-start" />
            Create user
          </Button>
        </DialogTrigger>
        <DialogContent
          aria-busy={createUser.isPending || undefined}
          showCloseButton={!revealedPassword}
        >
          {revealedPassword ? (
            <RevealPasswordContent
              password={revealedPassword}
              title="Copy the new user's password"
              description="This is the only time this password is shown. Share it with the new user through a secure channel — they must change it before doing anything else."
              onClose={() => {
                setRevealedPassword(null);
                setOpen(false);
                createUser.reset();
              }}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create user</DialogTitle>
                <DialogDescription>
                  A generated password is shown once, right after creation. The
                  new account must change it before doing anything else.
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={onSubmit}
                className="flex flex-col gap-3"
                noValidate
              >
                <fieldset disabled={createUser.isPending} className="contents">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="new-user-email">Email</Label>
                    <Input
                      id="new-user-email"
                      type="email"
                      autoFocus
                      aria-invalid={errors.email ? true : undefined}
                      {...register("email")}
                    />
                    {errors.email ? (
                      <p className="text-danger text-[12px]">
                        {errors.email.message}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="new-user-name">Name</Label>
                    <Input
                      id="new-user-name"
                      aria-invalid={errors.name ? true : undefined}
                      {...register("name")}
                    />
                    {errors.name ? (
                      <p className="text-danger text-[12px]">
                        {errors.name.message}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="new-user-role">Role</Label>
                    <Controller
                      control={control}
                      name="role"
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                          disabled={createUser.isPending}
                        >
                          <SelectTrigger id="new-user-role" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {GLOBAL_ROLES.map((role) => (
                              <SelectItem key={role} value={role}>
                                {role}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="new-user-password">Password</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const password = generatePassword(20);
                          generatedPassword.current = password;
                          for (const field of [
                            "password",
                            "confirmPassword",
                          ] as const)
                            setValue(field, password, {
                              shouldValidate: true,
                              shouldDirty: true,
                            });
                        }}
                      >
                        <RefreshCw data-icon="inline-start" />
                        Generate
                      </Button>
                    </div>
                    <Input
                      id="new-user-password"
                      type="password"
                      autoComplete="new-password"
                      aria-invalid={errors.password ? true : undefined}
                      {...register("password")}
                    />
                    {errors.password ? (
                      <p className="text-danger text-[12px]">
                        {errors.password.message}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="new-user-confirm-password">
                      Confirm password
                    </Label>
                    <Input
                      id="new-user-confirm-password"
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

                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="outline" disabled={createUser.isPending}>
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="submit" disabled={createUser.isPending}>
                      {createUser.isPending ? "Creating…" : "Create"}
                    </Button>
                  </DialogFooter>
                </fieldset>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
