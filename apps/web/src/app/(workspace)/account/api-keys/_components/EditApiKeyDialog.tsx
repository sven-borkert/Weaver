"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil } from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import { useForm } from "react-hook-form";
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
import { focusDialogTarget } from "~/lib/dialog-focus";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  ApiKeyPolicyFields,
  apiKeyPolicyFormSchema,
  policyCapabilities,
  policyRateLimit,
  type Project,
} from "./ApiKeyPolicyFields";

/** Client-side mirror of the server's apiKey.update input. */
const editApiKeyFormSchema = apiKeyPolicyFormSchema.extend({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(80, "Name must be at most 80 characters"),
});

type EditApiKeyFormValues = z.infer<typeof editApiKeyFormSchema>;

type ApiKeyRow = RouterOutputs["apiKey"]["list"][number];

function valuesFor(apiKey: ApiKeyRow): EditApiKeyFormValues {
  return {
    name: apiKey.name,
    propose: apiKey.capabilities.includes("content:propose"),
    write: apiKey.capabilities.includes("content:write"),
    admin: apiKey.capabilities.includes("system:admin"),
    ingest: apiKey.capabilities.includes("ingest:external"),
    external: apiKey.capabilities.includes("external:use"),
    externalManage: apiKey.capabilities.includes("external:manage"),
    projectIds: apiKey.projectIds,
    rateLimitPerMinute:
      apiKey.rateLimitPerMinute === null
        ? ""
        : String(apiKey.rateLimitPerMinute),
  };
}

export function EditApiKeyDialog({
  apiKey,
  isAdmin,
  projects,
  fallbackFocusRef,
  projectsReady = true,
  projectsError = false,
  retryProjects,
}: {
  apiKey: ApiKeyRow;
  isAdmin: boolean;
  projects: Project[];
  projectsReady?: boolean;
  projectsError?: boolean;
  retryProjects?: () => void;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dormantAdmin = !isAdmin && apiKey.capabilities.includes("system:admin");

  const {
    register,
    handleSubmit,
    control,
    setError,
    reset,
    formState: { errors },
  } = useForm<EditApiKeyFormValues>({
    resolver: zodResolver(editApiKeyFormSchema),
    defaultValues: valuesFor(apiKey),
  });

  const updateKey = api.apiKey.update.useMutation({
    onSuccess: () => {
      toast.success("API key updated");
      void utils.apiKey.list.invalidate();
      setOpen(false);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error(err.message || "Could not update the API key");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    if (!projectsReady) return;
    updateKey.mutate({
      keyId: apiKey.id,
      name: values.name,
      // A non-Admin never sees the admin checkbox, so saving drops a dormant grant.
      capabilities: policyCapabilities({
        ...values,
        admin: isAdmin && values.admin,
      }),
      projectIds: values.projectIds,
      rateLimitPerMinute: policyRateLimit(values),
    });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (updateKey.isPending) return;
        // Each opening starts from the row as currently listed.
        if (nextOpen) reset(valuesFor(apiKey));
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${apiKey.name}`}
        >
          <Pencil />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        aria-busy={updateKey.isPending || undefined}
        showCloseButton={!updateKey.isPending}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(triggerRef.current, fallbackFocusRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit API key</DialogTitle>
          <DialogDescription>
            Changes apply to the next request made with this key. The key itself
            and its expiry stay the same.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
          <fieldset disabled={updateKey.isPending} className="contents">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`edit-api-key-${apiKey.id}-name`}>Name</Label>
              <Input
                id={`edit-api-key-${apiKey.id}-name`}
                autoFocus
                aria-invalid={errors.name ? true : undefined}
                {...register("name")}
              />
              {errors.name ? (
                <p className="text-danger text-[12px]">{errors.name.message}</p>
              ) : null}
            </div>

            {projectsReady ? (
              <ApiKeyPolicyFields
                register={register}
                control={control}
                errors={errors}
                isAdmin={isAdmin}
                projects={projects}
                idPrefix={`edit-api-key-${apiKey.id}`}
              />
            ) : (
              <p role="status">
                {projectsError
                  ? "Could not load project restrictions."
                  : "Loading project restrictions…"}{" "}
                {projectsError ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={retryProjects}
                  >
                    Retry
                  </Button>
                ) : null}
              </p>
            )}
            {dormantAdmin ? (
              <p className="text-text-3 m-0 text-[12px]">
                Saving removes the inactive system administration grant; only an
                Admin can grant it again.
              </p>
            ) : null}

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={updateKey.isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={updateKey.isPending || !projectsReady}
              >
                {updateKey.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
