"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, Plus } from "lucide-react";
import { useState } from "react";
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
import { api } from "~/trpc/react";
import {
  ApiKeyPolicyFields,
  apiKeyPolicyFormSchema,
  policyCapabilities,
  policyRateLimit,
  type Project,
} from "./ApiKeyPolicyFields";

/** Client-side mirror of the server's apiKey.create input. */
const createApiKeyFormSchema = apiKeyPolicyFormSchema.extend({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(80, "Name must be at most 80 characters"),
  expiresInDays: z.enum(["never", "7", "30", "90", "365"]),
});

type CreateApiKeyFormValues = z.infer<typeof createApiKeyFormSchema>;

const defaultValues: CreateApiKeyFormValues = {
  name: "",
  propose: false,
  write: false,
  admin: false,
  ingest: false,
  external: false,
  externalManage: false,
  projectIds: [],
  expiresInDays: "never",
  rateLimitPerMinute: "",
};

export function CreateApiKeyDialog({
  isAdmin,
  projects,
}: {
  isAdmin: boolean;
  projects: Project[];
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    setError,
    reset,
    formState: { errors },
  } = useForm<CreateApiKeyFormValues>({
    resolver: zodResolver(createApiKeyFormSchema),
    defaultValues,
  });

  const createKey = api.apiKey.create.useMutation({
    // The success result carries the plaintext secret. gcTime: 0 evicts it
    // from the QueryClient's mutation cache as soon as the observer detaches
    // — close() below calls reset() to detach it; the two work as a pair.
    gcTime: 0,
    onSuccess: (result) => {
      toast.success("API key created");
      void utils.apiKey.list.invalidate();
      setSecret(result.secret);
      reset(defaultValues);
    },
    onError: (err) => {
      if (err.data?.field) {
        applyTrpcErrorToForm(err, (name, error) =>
          setError(name as Parameters<typeof setError>[0], error),
        );
      } else {
        toast.error(err.message || "Could not create the API key");
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    createKey.mutate({
      name: values.name,
      capabilities: policyCapabilities(values),
      projectIds: values.projectIds,
      expiresInDays:
        values.expiresInDays === "never" ? null : Number(values.expiresInDays),
      rateLimitPerMinute: policyRateLimit(values),
    });
  });

  function close() {
    setOpen(false);
    setSecret(null);
    setCopied(false);
    reset(defaultValues);
    createKey.reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (createKey.isPending) return;
        // While the one-time secret is visible, only the explicit confirm button closes.
        if (!nextOpen && secret) return;
        if (nextOpen) setOpen(true);
        else close();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus data-icon="inline-start" />
          Create key
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        aria-busy={createKey.isPending || undefined}
        showCloseButton={!secret && !createKey.isPending}
      >
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle>Copy your new API key</DialogTitle>
              <DialogDescription>
                This is the only time the full key is shown. Store it somewhere
                safe; you can revoke it at any time. To close this dialog,
                confirm below that you have copied the key.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-api-key-secret">New API key</Label>
              <div className="flex gap-2">
                <Input
                  id="new-api-key-secret"
                  readOnly
                  value={secret}
                  className="font-mono text-[12px]"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Copy API key"
                  onClick={() => {
                    if (!navigator.clipboard) {
                      toast.error(
                        "Copy failed — select the key and copy manually",
                      );
                      return;
                    }
                    void navigator.clipboard
                      .writeText(secret)
                      .then(() => setCopied(true))
                      .catch(() =>
                        toast.error(
                          "Copy failed — select the key and copy manually",
                        ),
                      );
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" onClick={close}>
                I have copied the key
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                The key acts as you. Every key can read your projects and
                connect through MCP; add write access or narrow it to specific
                projects below.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={onSubmit}
              className="flex flex-col gap-3"
              noValidate
            >
              <fieldset disabled={createKey.isPending} className="contents">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    autoFocus
                    placeholder="Claude Desktop on my laptop"
                    aria-invalid={errors.name ? true : undefined}
                    {...register("name")}
                  />
                  {errors.name ? (
                    <p className="text-danger text-[12px]">
                      {errors.name.message}
                    </p>
                  ) : null}
                </div>

                <ApiKeyPolicyFields
                  register={register}
                  control={control}
                  errors={errors}
                  isAdmin={isAdmin}
                  projects={projects}
                  idPrefix="api-key"
                >
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="api-key-expiry">Expires</Label>
                    <Controller
                      control={control}
                      name="expiresInDays"
                      render={({ field }) => (
                        <Select
                          disabled={createKey.isPending}
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger id="api-key-expiry" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="never">Never</SelectItem>
                            <SelectItem value="7">In 7 days</SelectItem>
                            <SelectItem value="30">In 30 days</SelectItem>
                            <SelectItem value="90">In 90 days</SelectItem>
                            <SelectItem value="365">In 1 year</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>
                </ApiKeyPolicyFields>

                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline" disabled={createKey.isPending}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button type="submit" disabled={createKey.isPending}>
                    {createKey.isPending ? "Creating…" : "Create"}
                  </Button>
                </DialogFooter>
              </fieldset>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
