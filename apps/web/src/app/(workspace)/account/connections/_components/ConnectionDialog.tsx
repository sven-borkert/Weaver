"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import { useForm, useWatch } from "react-hook-form";
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
  connectionDefaults,
  connectionDraftReducer,
  connectionFormSchema,
  needsTokenReentry,
  tokenPatch,
  updateInput,
  startConnectionDraft,
  type ConnectionFormValues as Values,
} from "./connectionDraft";

type Detail = RouterOutputs["externalMcp"]["get"];
export function ConnectionDialog({
  open,
  onOpenChange,
  connection,
  onCreated,
  returnFocusRef,
  fallbackFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection?: Detail;
  onCreated?: (connection: { id: string }) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const utils = api.useUtils();
  const [conflict, setConflict] = useState(false);
  const wasOpen = useRef(false);
  const [draft, dispatchDraft] = useReducer(
    connectionDraftReducer,
    connection,
    startConnectionDraft,
  );
  const defaults = connectionDefaults(connection);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    control,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: defaults,
  });
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset(defaults);
      dispatchDraft({ type: "open", connection });
      setConflict(false);
    }
    wasOpen.current = open;
  }, [connection, defaults, open, reset]);
  const error = (err: Parameters<typeof applyTrpcErrorToForm>[0]) => {
    if (err.data?.field)
      applyTrpcErrorToForm(err, (name, e) => setError(name as keyof Values, e));
    else if (err.data?.code === "CONFLICT") setConflict(true);
    else toast.error(err.message || "Could not save connection");
  };
  const done = (saved: Parameters<typeof connectionDefaults>[0]) => {
    reset(connectionDefaults(saved));
    if (saved && "id" in saved && "revision" in saved)
      dispatchDraft({ type: "saved", connection: saved as never });
    else dispatchDraft({ type: "saved" });
    toast.success("Connection saved");
    void utils.externalMcp.invalidate();
    onOpenChange(false);
  };
  const create = api.externalMcp.create.useMutation({
    onSuccess: (saved) => {
      done(saved);
      onCreated?.(saved);
    },
    onError: error,
  });
  const update = api.externalMcp.update.useMutation({
    onSuccess: done,
    onError: error,
  });
  const pending = create.isPending || update.isPending;
  const authMode = useWatch({ control, name: "authMode" });
  useEffect(() => {
    if (authMode === "none") setValue("token", "");
  }, [authMode, setValue]);
  const reloadLatest = async () => {
    if (!connection) return;
    const latest = await utils.externalMcp.get.fetch({ id: connection.id });
    reset(connectionDefaults(latest));
    dispatchDraft({ type: "open", connection: latest });
    setConflict(false);
  };
  const submit = handleSubmit((values) => {
    if (!connection && values.authMode === "bearer" && !values.token) {
      setError("token", { message: "Bearer token is required" });
      return;
    }
    if (needsTokenReentry(connection, values)) {
      setError("token", {
        message:
          "Re-enter the bearer token to send it to a different endpoint origin",
      });
      return;
    }
    if (connection && draft.identity)
      update.mutate(updateInput(draft.identity, values));
    else
      create.mutate({
        name: values.name,
        endpoint: values.endpoint,
        enabled: true,
        authMode: values.authMode,
        ...tokenPatch(values),
        timeoutMs: values.timeoutMs,
        allowInsecureTls: values.allowInsecureTls,
      });
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
            {connection ? "Edit connection" : "Add connection"}
          </DialogTitle>
          <DialogDescription>
            Your connection acts as you in the other app. The token is
            write-only and cannot be viewed after saving.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <fieldset disabled={pending} className="contents">
            <Field label="Name" error={errors.name?.message}>
              <Input
                autoFocus
                aria-invalid={!!errors.name || undefined}
                {...register("name")}
              />
            </Field>
            <Field label="Endpoint" error={errors.endpoint?.message}>
              <Input
                type="url"
                aria-invalid={!!errors.endpoint || undefined}
                {...register("endpoint")}
              />
            </Field>
            <Field label="Authentication" error={errors.authMode?.message}>
              <select
                className="border-line bg-surface text-text rounded-lg border px-3 py-2 text-[13px]"
                {...register("authMode")}
              >
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
              </select>
            </Field>
            {authMode === "bearer" ? (
              <Field label="Bearer token" error={errors.token?.message}>
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    connection ? "Leave blank to keep current token" : undefined
                  }
                  {...register("token")}
                />
              </Field>
            ) : null}
            <p className="text-text-3 m-0 text-[12px]">
              The assistant calls enabled tools on its own and asks before a
              write tool unless Auto-approve is on in the conversation. MCP
              clients that connect to Weaver ask for confirmation on their side.
            </p>
            {connection ? (
              <label className="text-text flex items-center gap-2 text-[13px]">
                <input type="checkbox" {...register("enabled")} />
                Enabled
              </label>
            ) : (
              <p className="text-text-3 m-0 text-[12px]">
                Weaver discovers the tools after saving. They start disabled;
                you choose which to enable.
              </p>
            )}
            <details className="flex flex-col gap-3">
              <summary className="text-text-2 cursor-pointer text-[13px]">
                Advanced
              </summary>
              <Field
                label="Timeout (milliseconds)"
                error={errors.timeoutMs?.message}
              >
                <Input
                  type="number"
                  min={5000}
                  max={120000}
                  {...register("timeoutMs", { valueAsNumber: true })}
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <label className="text-text flex items-center gap-2 text-[13px]">
                  <input type="checkbox" {...register("allowInsecureTls")} />
                  Accept any certificate
                </label>
                <p className="text-text-3 m-0 text-[12px]">
                  Skips all TLS certificate validation for this connection —
                  chain, expiry, and hostname. Only use this for endpoints you
                  already trust.
                </p>
              </div>
            </details>
            {conflict ? (
              <div
                role="alert"
                className="border-danger-border bg-danger-bg rounded-lg border p-3"
              >
                <p className="text-danger m-0 text-[12px]">
                  This connection changed. Reload its latest settings before
                  reviewing and saving again.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => void reloadLatest()}
                >
                  Reload latest settings
                </Button>
              </div>
            ) : null}
          </fieldset>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save connection"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="text-text flex flex-col gap-1.5 text-[13px]">
      <span>{label}</span>
      {children}
      {error ? <span className="text-danger text-[12px]">{error}</span> : null}
    </label>
  );
}
