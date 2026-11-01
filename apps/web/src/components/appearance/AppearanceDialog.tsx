"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FileText, Folder, Palette, Table2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch, type FieldPath } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  applyAppearancePatch,
  assertAppearancePatch,
  BUILTIN_ICON_NAMES,
  type Appearance,
  type AppearanceIcon as Icon,
  type AppearancePatch,
  type AppearanceTarget,
} from "@weaver/core/appearance/metadata";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { withBasePath } from "~/lib/basePath";
import { focusDialogTarget } from "~/lib/dialog-focus";
import { dataUnlessAccessError } from "~/lib/query-presentation";
import { applyTrpcErrorToForm } from "~/lib/trpcErrors";
import { api } from "~/trpc/react";
import { AppearanceIcon, builtinIcons } from "./AppearanceIcon";
import { appearanceStyle } from "./appearance-style";

const COLORS = [
  "#ffffff",
  "#000000",
  "#fef3c7",
  "#d1fae5",
  "#dbeafe",
  "#ede9fe",
  "#fce7f3",
];
// Client-side mirror of the server's strict appearance patch validation.
const schema = z
  .object({
    backgroundColor: z.string().nullable(),
    icon: z.custom<Icon>().nullable(),
  })
  .superRefine((value, ctx) => {
    try {
      assertAppearancePatch(value);
    } catch (error) {
      const details = (error as { details?: { field?: string } }).details;
      ctx.addIssue({
        code: "custom",
        path: [details?.field ?? "icon"],
        message: error instanceof Error ? error.message : "Invalid appearance",
      });
    }
  });
type Values = z.infer<typeof schema>;

export type AppearanceDialogProps = {
  target: AppearanceTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void | Promise<void>;
};

export function AppearanceDialog(props: AppearanceDialogProps) {
  return props.open ? (
    <OpenAppearanceDialog key={JSON.stringify(props.target)} {...props} />
  ) : null;
}

function OpenAppearanceDialog({
  target,
  open,
  onOpenChange,
  onSaved,
}: AppearanceDialogProps) {
  const query = api.appearance.get.useQuery(
    { target },
    { enabled: open, refetchOnMount: "always" },
  );
  const data = dataUnlessAccessError(query.data, query.error);
  const [pending, setPending] = useState(false);
  const trigger = useRef(
    typeof document === "undefined"
      ? null
      : (document.querySelector<HTMLElement>(
          `[data-appearance-trigger="${appearanceTriggerKey(target)}"]`,
        ) ?? (document.activeElement as HTMLElement | null)),
  );
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    focusDialogTarget(
      trigger.current,
      typeof document === "undefined"
        ? null
        : document.querySelector<HTMLElement>(
            "[data-explorer-focus], [data-table-workspace-focus], [data-document-title]",
          ),
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      {data ? (
        <AppearanceForm
          key={JSON.stringify(target)}
          target={target}
          appearance={data.appearance}
          revision={data.revision}
          canEdit={data.canEdit}
          refreshing={query.isFetching}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
          onCloseAutoFocus={restoreFocus}
          onPendingChange={setPending}
          onReload={() => void query.refetch()}
        />
      ) : (
        <DialogContent onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Appearance</DialogTitle>
            <DialogDescription>Choose a background and icon.</DialogDescription>
          </DialogHeader>
          <p role={query.error ? "alert" : "status"}>
            {query.error
              ? "Could not load appearance. Try again."
              : "Loading appearance…"}
          </p>
          {query.error ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          ) : null}
        </DialogContent>
      )}
    </Dialog>
  );
}

function AppearanceForm({
  target,
  appearance,
  revision,
  canEdit,
  refreshing,
  onOpenChange,
  onSaved,
  onCloseAutoFocus,
  onPendingChange,
  onReload,
}: {
  target: AppearanceTarget;
  appearance: Appearance | null;
  revision: string;
  canEdit: boolean;
  refreshing: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void | Promise<void>;
  onCloseAutoFocus: (event: Event) => void;
  onPendingChange: (pending: boolean) => void;
  onReload: () => void;
}) {
  const utils = api.useUtils();
  const mutation = api.appearance.set.useMutation();
  const [pending, setPending] = useState(false);
  const [file, setFile] = useState<File>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const {
    register,
    control,
    setValue,
    setError,
    clearErrors,
    handleSubmit,
    formState: { errors, dirtyFields },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    values: {
      backgroundColor: appearance?.backgroundColor ?? null,
      icon: appearance?.icon ?? null,
    },
    resetOptions: { keepDirtyValues: true },
  });
  const values: Values = {
    backgroundColor: useWatch({ control, name: "backgroundColor" }),
    icon: useWatch({ control, name: "icon" }),
  };
  const disabled = pending || refreshing || !canEdit;
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);
  const patch: AppearancePatch = {
    ...(dirtyFields.backgroundColor
      ? { backgroundColor: values.backgroundColor }
      : {}),
    ...(dirtyFields.icon ? { icon: values.icon } : {}),
  };
  const preview = applyAppearancePatch(appearance, patch);
  const fallback =
    target.kind === "folder"
      ? Folder
      : target.kind === "table"
        ? Table2
        : FileText;
  const chooseIcon = (icon: Icon | null) => {
    setFile(undefined);
    setPreviewUrl(undefined);
    setFileError(undefined);
    clearErrors("icon");
    setValue("icon", icon, { shouldDirty: true });
  };
  const invalidate = async () => {
    await utils.appearance.get.invalidate({ target });
    if (
      target.kind === "table" ||
      (target.kind === "folder" && target.scope === "tables")
    ) {
      await Promise.all([
        utils.tableFolder.tree.invalidate({ projectId: target.projectId }),
        utils.table.list.invalidate({ projectId: target.projectId }),
        utils.table.get.invalidate({ projectId: target.projectId }),
        utils.table.history.invalidate({ projectId: target.projectId }),
      ]);
    } else {
      await Promise.all([
        utils.folder.tree.invalidate({ projectId: target.projectId }),
        utils.document.list.invalidate({ projectId: target.projectId }),
        utils.document.get.invalidate({ projectId: target.projectId }),
        utils.document.history.invalidate({ projectId: target.projectId }),
      ]);
    }
  };
  const submit = handleSubmit(async () => {
    if (disabled || fileError) return;
    setPending(true);
    onPendingChange(true);
    setMessage(undefined);
    try {
      if (file) {
        const body = new FormData();
        body.set("target", JSON.stringify(target));
        body.set("expectedRevision", revision);
        body.set("patch", JSON.stringify(patch));
        body.set("file", file);
        const response = await fetch(
          withBasePath(
            `/api/projects/${encodeURIComponent(target.projectId)}/appearance`,
          ),
          { method: "POST", body },
        );
        if (!response.ok) {
          const payload = (await response.json()) as {
            error?: string;
            field?: string;
          };
          if (payload.field === "icon" || payload.field === "backgroundColor")
            setError(payload.field, {
              message: payload.error ?? "Could not save appearance",
            });
          throw new Error(
            payload.error ?? "Could not upload the image. Try again.",
          );
        }
      } else
        await mutation.mutateAsync({
          target,
          expectedRevision: revision,
          patch,
        });
      await invalidate();
      await onSaved?.();
      toast.success("Appearance saved");
      onOpenChange(false);
    } catch (error) {
      const field = (error as { data?: { field?: string } }).data?.field;
      if (field === "icon" || field === "backgroundColor")
        applyTrpcErrorToForm(
          error as Parameters<typeof applyTrpcErrorToForm>[0],
          (name, error) => setError(name as FieldPath<Values>, error),
        );
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not save appearance. Try again.",
      );
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  });
  return (
    <DialogContent
      className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      aria-busy={pending}
      showCloseButton={!pending}
      onInteractOutside={(event) => {
        if (pending) event.preventDefault();
      }}
      onEscapeKeyDown={(event) => {
        if (pending) event.preventDefault();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <DialogHeader>
        <DialogTitle>Appearance</DialogTitle>
        <DialogDescription>
          Choose a background and icon. Reset either to use its default.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div
          aria-label="Appearance preview"
          style={appearanceStyle(preview)}
          className="border-line bg-surface flex items-center gap-3 rounded-lg border p-4"
        >
          {file && previewUrl ? (
            <LocalImagePreview src={previewUrl} />
          ) : (
            <AppearanceIcon
              projectId={target.projectId}
              appearance={preview}
              fallback={fallback}
              size={40}
            />
          )}
          <span className="font-medium">
            {target.kind === "folder"
              ? "Folder"
              : target.kind === "table"
                ? "Table"
                : "Document"}
          </span>
        </div>
        <fieldset disabled={disabled} className="flex flex-col gap-2">
          <legend className="text-text text-sm font-medium">Background</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((color) => (
              <Button
                key={color}
                type="button"
                variant="outline"
                size="sm"
                style={appearanceStyle({ backgroundColor: color })}
                onClick={() =>
                  setValue("backgroundColor", color, { shouldDirty: true })
                }
              >
                {color}
              </Button>
            ))}
          </div>
          <Label htmlFor="appearance-color">Custom hex color</Label>
          <Input
            id="appearance-color"
            {...register("backgroundColor", {
              setValueAs: (value: string) => (value === "" ? null : value),
            })}
            aria-invalid={Boolean(errors.backgroundColor)}
            placeholder="#aabbcc"
          />
          {errors.backgroundColor ? (
            <p role="alert" className="text-danger text-xs">
              {errors.backgroundColor.message}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setValue("backgroundColor", null, { shouldDirty: true })
            }
          >
            Reset background
          </Button>
        </fieldset>
        <fieldset disabled={disabled} className="flex flex-col gap-2">
          <legend className="text-text text-sm font-medium">Icon</legend>
          <div className="flex flex-wrap gap-2">
            {BUILTIN_ICON_NAMES.map((name) => {
              const Icon = builtinIcons[name];
              return (
                <Button
                  key={name}
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Use ${name} icon`}
                  title={name}
                  onClick={() => chooseIcon({ type: "builtin", name })}
                >
                  <Icon />
                </Button>
              );
            })}
          </div>
          <Label htmlFor="appearance-emoji">Emoji</Label>
          <Input
            id="appearance-emoji"
            value={values.icon?.type === "emoji" ? values.icon.value : ""}
            onChange={(event) =>
              chooseIcon(
                event.target.value
                  ? { type: "emoji", value: event.target.value }
                  : null,
              )
            }
            aria-invalid={Boolean(errors.icon ?? fileError)}
          />
          <Label htmlFor="appearance-image">
            Upload image (PNG, JPEG or WebP, up to 2 MiB)
          </Label>
          <Input
            id="appearance-image"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const next = event.target.files?.[0];
              if (!next) return;
              if (
                next.size > 2 * 1024 * 1024 ||
                !["image/png", "image/jpeg", "image/webp"].includes(next.type)
              ) {
                setFile(undefined);
                setPreviewUrl(undefined);
                setFileError("Choose a PNG, JPEG or WebP image up to 2 MiB");
                setError("icon", {
                  message: "Choose a PNG, JPEG or WebP image up to 2 MiB",
                });
                return;
              }
              chooseIcon(appearance?.icon ?? null);
              setFile(next);
              if (typeof URL.createObjectURL === "function")
                setPreviewUrl(URL.createObjectURL(next));
            }}
          />
          {file ? <p className="text-text-2 text-xs">{file.name}</p> : null}
          {(errors.icon ?? fileError) ? (
            <p role="alert" className="text-danger text-xs">
              {fileError ?? errors.icon?.message}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => chooseIcon(null)}
          >
            Reset icon
          </Button>
        </fieldset>
        {message ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-danger text-sm">
              {message}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={onReload}
            >
              Reload appearance
            </Button>
          </div>
        ) : null}
        {!canEdit ? (
          <p role="alert">You no longer have permission to edit appearance.</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={disabled || Boolean(fileError)}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function AppearanceMenuAction({
  onAppearance,
}: {
  onAppearance: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onAppearance}>
      <Palette />
      Appearance
    </DropdownMenuItem>
  );
}

function LocalImagePreview({ src }: { src: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Blob previews cannot use the image optimizer.
    <img
      src={src}
      alt="Selected icon preview"
      className="size-10 object-contain"
    />
  );
}

export function appearanceTriggerKey(target: AppearanceTarget): string {
  return encodeURIComponent(JSON.stringify(target));
}
