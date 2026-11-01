"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { oidcUrlSchema, type OidcDiscoveryResult } from "@weaver/config/oidc";
import { api, type RouterOutputs } from "~/trpc/react";
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
import { queryErrorCode } from "~/lib/query-presentation";
import {
  UNSAVED_CHANGES_CONFIRMATION,
  useUnsavedChangesGuard,
} from "~/lib/use-unsaved-changes-guard";
import { OidcMetadataPanel } from "./OidcMetadataPanel";

type Settings = RouterOutputs["oidc"]["getSettings"];
// Client-side mirror of the server's OIDC settings input; the revision is held separately.
const formSchema = z
  .object({
    enabled: z.boolean(),
    displayName: z.string().trim().min(1).max(120),
    discoveryUrl: z.union([z.literal(""), oidcUrlSchema]),
    clientId: z.string().trim().max(1024),
    clientSecret: z.string().max(16384),
  })
  .superRefine((data, ctx) => {
    if (data.enabled)
      for (const field of ["discoveryUrl", "clientId"] as const)
        if (!data[field])
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "This field is required to enable OIDC.",
          });
  });
type Values = z.infer<typeof formSchema>;
function defaults(settings: Settings): Values {
  return {
    enabled: settings.enabled,
    displayName: settings.displayName,
    discoveryUrl: settings.discoveryUrl,
    clientId: settings.clientId,
    clientSecret: "",
  };
}

export function OidcSettingsForm({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (saved: Settings) => void;
}) {
  const utils = api.useUtils();
  const [baseline, setBaseline] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tested, setTested] = useState<{
    url: string;
    result: OidcDiscoveryResult;
  } | null>(
    settings.discovery
      ? { url: settings.discoveryUrl, result: settings.discovery }
      : null,
  );
  const urlGeneration = useRef(0);
  const mounted = useRef(true);
  const {
    register,
    handleSubmit,
    getValues,
    reset,
    setError,
    clearErrors,
    formState: { errors, isDirty },
  } = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults(settings),
  });
  const save = api.oidc.updateSettings.useMutation({ gcTime: 0 });
  const test = api.oidc.testConnection.useMutation({ gcTime: 0 });
  useUnsavedChangesGuard(isDirty);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const adopt = useCallback(
    (saved: Settings) => {
      setBaseline(saved);
      reset(defaults(saved));
      setConflict(false);
      setMessage(null);
      urlGeneration.current++;
      setTested(
        saved.discovery
          ? { url: saved.discoveryUrl, result: saved.discovery }
          : null,
      );
    },
    [reset],
  );
  async function refresh() {
    try {
      await utils.oidc.getSettings.invalidate(undefined, undefined, {
        throwOnError: true,
      });
      if (mounted.current) setRefreshFailed(false);
    } catch {
      if (mounted.current) setRefreshFailed(true);
    }
  }
  async function submit(values: Values) {
    if (saving || refreshFailed || conflict) return;
    setSaving(true);
    setMessage(null);
    clearErrors();
    let saved: Settings;
    try {
      saved = await save.mutateAsync({
        ...values,
        expectedRevision: baseline.revision,
      });
    } catch (error) {
      if (mounted.current) {
        setConflict(queryErrorCode(error) === "CONFLICT");
        applyTrpcErrorToForm(
          error as Parameters<typeof applyTrpcErrorToForm>[0],
          (name, fieldError) => {
            if (name in values) setError(name as keyof Values, fieldError);
          },
        );
        setMessage(
          error instanceof Error
            ? error.message
            : "Could not save OIDC settings. Reload if the settings changed.",
        );
        setSaving(false);
      }
      save.reset();
      return;
    }
    save.reset();
    if (!mounted.current) return;
    adopt(saved);
    onSaved(saved);
    toast.success("OIDC settings saved");
    await refresh();
    if (mounted.current) setSaving(false);
  }
  async function testConnection() {
    const parsed = oidcUrlSchema.safeParse(getValues("discoveryUrl"));
    if (!parsed.success) {
      setError("discoveryUrl", {
        message: "Enter a valid discovery URL before testing.",
      });
      return;
    }
    const generation = urlGeneration.current;
    setTesting(true);
    setTested(null);
    setMessage(null);
    clearErrors("discoveryUrl");
    try {
      const result = await test.mutateAsync({ discoveryUrl: parsed.data });
      if (mounted.current && generation === urlGeneration.current)
        setTested({ url: parsed.data, result });
    } catch (error) {
      if (mounted.current && generation === urlGeneration.current) {
        applyTrpcErrorToForm(
          error as Parameters<typeof applyTrpcErrorToForm>[0],
          (name, fieldError) => {
            if (name === "discoveryUrl") setError("discoveryUrl", fieldError);
          },
        );
        setMessage(
          error instanceof Error
            ? error.message
            : "Could not test the OIDC server.",
        );
      }
    } finally {
      test.reset();
      if (mounted.current) setTesting(false);
    }
  }
  async function reloadLatest() {
    if (isDirty && !window.confirm(UNSAVED_CHANGES_CONFIRMATION)) return;
    setReloading(true);
    try {
      const latest = await utils.oidc.getSettings.fetch(undefined, {
        staleTime: 0,
      });
      if (mounted.current) adopt(latest);
    } catch {
      if (mounted.current)
        setMessage("Could not reload OIDC settings. Your draft is preserved.");
    } finally {
      if (mounted.current) setReloading(false);
    }
  }
  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(baseline.callbackUrl);
      toast.success("Callback URL copied");
    } catch {
      toast.error(
        "Could not copy the callback URL. Select it to copy manually.",
      );
    }
  }
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2 className="m-0 text-base font-semibold">OIDC sign-in</h2>
        </CardTitle>
        <CardDescription>
          Configure one identity provider for browser sign-in. Password login
          remains available.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <p className="text-text-3 m-0 text-[12px]">
          {baseline.source === "environment"
            ? "Using server environment configuration. Save to manage this configuration here."
            : baseline.source === "database"
              ? "Using saved administration settings."
              : "No identity provider is configured."}
        </p>
        {!settings.encryptionConfigured ? (
          <p role="alert" className="text-danger text-[13px]">
            Set WEAVER_ENCRYPTION_KEYS on the server before saving a client
            secret.
          </p>
        ) : null}
        <form
          onSubmit={(event) => handleSubmit(submit)(event)}
          aria-busy={saving}
          className="flex min-w-0 flex-col gap-4"
        >
          <fieldset
            disabled={saving || reloading || refreshFailed}
            className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
          >
            <div className="flex items-center gap-2">
              <input
                id="oidc-enabled"
                type="checkbox"
                role="switch"
                className="accent-brand-text size-4"
                {...register("enabled")}
              />
              <Label htmlFor="oidc-enabled">Enable OIDC sign-in</Label>
            </div>
            <p className="text-text-3 m-0 text-[12px]">
              Disabling OIDC stops new OIDC sign-ins. Existing Weaver sessions
              continue until they expire or are revoked.
            </p>
            {(
              [
                ["displayName", "Display name", "text"],
                ["discoveryUrl", "Discovery URL", "url"],
                ["clientId", "Client ID", "text"],
                ["clientSecret", "Client secret", "password"],
              ] as const
            ).map(([name, label, type]) => {
              const field = register(name);
              return (
                <div key={name} className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={`oidc-${name}`}>{label}</Label>
                  <Input
                    id={`oidc-${name}`}
                    type={type}
                    autoComplete={
                      name === "clientSecret" ? "new-password" : "off"
                    }
                    {...field}
                    onChange={(event) => {
                      if (name === "discoveryUrl") {
                        urlGeneration.current++;
                        setTested(null);
                        setMessage(null);
                      }
                      void field.onChange(event);
                    }}
                    aria-invalid={Boolean(errors[name])}
                    aria-describedby={
                      errors[name]
                        ? `oidc-${name}-error`
                        : name === "clientSecret"
                          ? "oidc-secret-hint"
                          : undefined
                    }
                  />
                  {errors[name]?.message ? (
                    <p
                      id={`oidc-${name}-error`}
                      className="text-danger m-0 text-[12px]"
                    >
                      {errors[name].message}
                    </p>
                  ) : null}
                  {name === "clientSecret" ? (
                    <p
                      id="oidc-secret-hint"
                      className="text-text-3 m-0 text-[12px]"
                    >
                      {baseline.hasClientSecret
                        ? "A secret is configured. Leave blank to retain it or enter a replacement."
                        : "Enter the confidential client's secret. Saved secrets are encrypted and never shown again."}
                    </p>
                  ) : null}
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={testing || saving}
                onClick={() => void testConnection()}
              >
                {testing ? "Testing…" : "Test connection"}
              </Button>
              <Button type="submit" disabled={saving || conflict}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </fieldset>
          <p className="text-text-3 m-0 text-[12px]">
            Test fetches discovery metadata and signing keys without saving. It
            does not validate the client secret or complete a sign-in. Save
            validates metadata again and applies changes without a restart.
          </p>
        </form>
        {message ? (
          <p role="alert" className="text-danger m-0 text-[13px]">
            {message}
          </p>
        ) : null}
        {!conflict && settings.revision !== baseline.revision && !saving ? (
          <p className="text-text-3 m-0 text-[13px]">
            Settings have changed since this form was loaded. Your draft is
            preserved.
          </p>
        ) : null}
        {conflict || (settings.revision !== baseline.revision && !saving) ? (
          <Button
            type="button"
            variant="outline"
            disabled={saving || reloading}
            onClick={() => void reloadLatest()}
          >
            {reloading ? "Reloading…" : "Reload latest"}
          </Button>
        ) : null}
        {refreshFailed ? (
          <div
            role="alert"
            className="text-danger flex flex-wrap items-center gap-2 text-[13px]"
          >
            Settings were saved, but refreshing failed. Retry the refresh before
            editing.
            <Button
              type="button"
              variant="outline"
              onClick={() => void refresh()}
            >
              Retry refresh
            </Button>
          </div>
        ) : null}
        <div className="border-line flex min-w-0 flex-col gap-2 border-t pt-4">
          <Label htmlFor="oidc-callback">Callback URL</Label>
          <Input id="oidc-callback" readOnly value={baseline.callbackUrl} />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => void copyCallback()}
          >
            Copy callback URL
          </Button>
          <p className="text-text-3 m-0 text-[12px]">
            Register this exact redirect URI with the identity provider. Require
            verified email and restrict provider access to the intended users.
          </p>
        </div>
        {tested ? (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-text-3 m-0 text-[12px] wrap-anywhere">
              Metadata checked for {tested.url}
            </p>
            <OidcMetadataPanel result={tested.result} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
