"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, type RefObject } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
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
import { focusDialogTarget } from "~/lib/dialog-focus";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  remoteInstanceDefaults,
  remoteInstanceFormSchema,
  type RemoteInstanceFormValues as Values,
} from "./remoteInstanceForm";

type Remote = RouterOutputs["remoteInstance"]["list"][number];

export function RemoteInstanceDialog({
  open,
  onOpenChange,
  remote,
  returnFocusRef,
  fallbackFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remote?: Remote;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const utils = api.useUtils();
  const wasOpen = useRef(false);
  const defaults = remoteInstanceDefaults(remote);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(remoteInstanceFormSchema),
    defaultValues: defaults,
  });
  useEffect(() => {
    if (open && !wasOpen.current) reset(defaults);
    wasOpen.current = open;
  }, [defaults, open, reset]);

  const onSuccess = () => {
    toast.success("Remote instance saved");
    void utils.remoteInstance.invalidate();
    onOpenChange(false);
    reset(defaults);
  };
  const onError = (err: Parameters<typeof applyTrpcErrorToForm>[0]) => {
    if (err.data?.field)
      applyTrpcErrorToForm(err, (name, error) =>
        setError(name as keyof Values, error),
      );
    else toast.error(err.message || "Could not save the remote instance");
  };
  const create = api.remoteInstance.create.useMutation({
    onSuccess,
    onError,
  });
  const update = api.remoteInstance.update.useMutation({
    onSuccess,
    onError,
  });
  const pending = create.isPending || update.isPending;

  const submit = handleSubmit((values) => {
    if (remote)
      update.mutate({
        id: remote.id,
        expectedRevision: remote.revision,
        patch: values,
      });
    else create.mutate(values);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) reset(defaults);
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        aria-busy={pending || undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusDialogTarget(returnFocusRef.current, fallbackFocusRef.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {remote ? "Edit remote instance" : "Add remote instance"}
          </DialogTitle>
          <DialogDescription>
            Other Weaver instances users can send documents and tables to.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <fieldset disabled={pending} className="contents">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                autoFocus
                defaultValue={defaults.name}
                aria-invalid={!!errors.name || undefined}
                {...register("name")}
              />
              {errors.name ? (
                <p className="text-danger m-0 text-[12px]">
                  {errors.name.message}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="baseUrl">Base URL</Label>
              <Input
                id="baseUrl"
                placeholder="https://apps.example.com/weaver"
                defaultValue={defaults.baseUrl}
                aria-invalid={!!errors.baseUrl || undefined}
                {...register("baseUrl")}
              />
              <p className="text-text-3 m-0 text-[12px]">
                The instance&apos;s public URL including its base path, without
                a trailing slash
              </p>
              {errors.baseUrl ? (
                <p className="text-danger m-0 text-[12px]">
                  {errors.baseUrl.message}
                </p>
              ) : null}
            </div>
            <label className="text-text flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                defaultChecked={defaults.enabled}
                {...register("enabled")}
              />
              Enabled
            </label>
            {remote ? (
              <p className="text-text-3 m-0 text-[12px]">
                Changing the base URL disconnects every user from this instance;
                they connect again afterwards.
              </p>
            ) : null}
          </fieldset>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
