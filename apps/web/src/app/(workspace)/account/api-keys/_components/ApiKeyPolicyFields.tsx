"use client";

import {
  Controller,
  type Control,
  type FieldErrors,
  type Path,
  type UseFormRegister,
  useFormState,
} from "react-hook-form";
import { z } from "zod";

import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { RouterOutputs } from "~/trpc/react";

/** Client-side mirror of the policy part of the server's apiKey.create/update inputs. */
export const apiKeyPolicyFormSchema = z.object({
  propose: z.boolean(),
  write: z.boolean(),
  admin: z.boolean(),
  ingest: z.boolean(),
  external: z.boolean(),
  externalManage: z.boolean(),
  projectIds: z.array(z.uuid()).max(100),
  rateLimitPerMinute: z
    .string()
    .trim()
    .regex(/^\d*$/, "Enter a whole number")
    .refine(
      (value) =>
        value === "" || (Number(value) >= 1 && Number(value) <= 10_000),
      {
        message: "Between 1 and 10000 requests per minute",
      },
    ),
});

export type ApiKeyPolicyFormValues = z.infer<typeof apiKeyPolicyFormSchema>;

export type Project = RouterOutputs["project"]["list"][number];

export function policyCapabilities(values: ApiKeyPolicyFormValues) {
  return [
    ...(values.propose ? (["content:propose"] as const) : []),
    ...(values.write ? (["content:write"] as const) : []),
    ...(values.admin ? (["system:admin"] as const) : []),
    ...(values.ingest ? (["ingest:external"] as const) : []),
    ...(values.external ? (["external:use"] as const) : []),
    ...(values.externalManage ? (["external:manage"] as const) : []),
  ];
}

export function policyRateLimit(values: ApiKeyPolicyFormValues) {
  return values.rateLimitPerMinute === ""
    ? null
    : Number(values.rateLimitPerMinute);
}

export function ApiKeyPolicyFields<T extends ApiKeyPolicyFormValues>({
  register,
  control,
  errors,
  isAdmin,
  projects,
  idPrefix,
  children,
}: {
  register: UseFormRegister<T>;
  control: Control<T>;
  errors: FieldErrors<T>;
  isAdmin: boolean;
  projects: Project[];
  idPrefix: string;
  /** Rendered beside the rate limit field (the create dialog puts expiry there). */
  children?: React.ReactNode;
}) {
  const policyErrors = errors as FieldErrors<ApiKeyPolicyFormValues>;
  const { defaultValues } = useFormState({ control });
  const wasRestricted =
    ((defaultValues as Partial<ApiKeyPolicyFormValues> | undefined)?.projectIds
      ?.length ?? 0) > 0;
  return (
    <>
      <fieldset className="flex flex-col gap-1.5 border-0 p-0">
        <legend className="text-text-2 text-[12px] font-medium">
          Additional capabilities
        </legend>
        <label className="text-text flex items-center gap-2 text-[13px]">
          <input type="checkbox" {...register("propose" as Path<T>)} />
          Propose changes for my review
        </label>
        <label className="text-text flex items-center gap-2 text-[13px]">
          <input type="checkbox" {...register("write" as Path<T>)} />
          Edit content directly, without review
        </label>
        <label className="text-text flex items-center gap-2 text-[13px]">
          <input type="checkbox" {...register("ingest" as Path<T>)} />
          Submit files to Imports from external systems
        </label>
        <p className="text-text-3 m-0 text-[12px]">
          Lets an external system push files into Imports for your review. It
          never edits content and needs your Editor role in the target project.
        </p>
        <label className="text-text flex items-center gap-2 text-[13px]">
          <input type="checkbox" {...register("external" as Path<T>)} />
          Use your MCP connections
        </label>
        <p className="text-text-3 m-0 text-[12px]">
          Lets MCP clients call the tools you enabled under Account › MCP
          connections. Calls act as you in those apps.
        </p>
        <label className="text-text flex items-center gap-2 text-[13px]">
          <input type="checkbox" {...register("externalManage" as Path<T>)} />
          Manage your MCP connections
        </label>
        <p className="text-text-3 m-0 text-[12px]">
          Lets MCP clients add, change and delete your MCP connections and
          choose which tools are enabled.
        </p>
        {isAdmin ? (
          <label className="text-text flex items-center gap-2 text-[13px]">
            <input type="checkbox" {...register("admin" as Path<T>)} />
            System administration
          </label>
        ) : null}
        {isAdmin ? (
          <p className="text-text-3 m-0 text-[12px]">
            Reads every internal state and changes every administrative setting
            through MCP. Only while you remain an Admin.
          </p>
        ) : null}
        <p className="text-text-3 m-0 text-[12px]">
          Read access and MCP are always included.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5 border-0 p-0">
        <legend className="text-text-2 text-[12px] font-medium">
          Restrict to projects{" "}
          <span className="text-text-muted font-normal">
            (none selected = all your projects)
          </span>
        </legend>
        <Controller
          control={control}
          name={"projectIds" as Path<T>}
          render={({ field }) => {
            const selected = field.value as string[];
            // Never stripped silently: that would widen the key to every project.
            const unavailable = selected.filter(
              (id) => !projects.some((project) => project.id === id),
            );
            return (
              <div className="border-line flex max-h-40 flex-col gap-1 overflow-y-auto rounded-[6px] border p-2">
                {projects.length === 0 ? (
                  <span className="text-text-3 text-[12px]">
                    You are not a member of any project.
                  </span>
                ) : (
                  projects.map((project) => (
                    <label
                      key={project.id}
                      className="text-text flex items-center gap-2 text-[13px]"
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(project.id)}
                        onChange={(event) =>
                          field.onChange(
                            event.target.checked
                              ? [...selected, project.id]
                              : selected.filter((id) => id !== project.id),
                          )
                        }
                      />
                      {project.name}
                    </label>
                  ))
                )}
                {unavailable.map((id) => (
                  <label
                    key={id}
                    className="text-text-3 flex items-center gap-2 text-[13px]"
                  >
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        field.onChange(selected.filter((other) => other !== id))
                      }
                    />
                    Unavailable project
                  </label>
                ))}
                {unavailable.length > 0 ? (
                  <span className="text-text-3 text-[12px]">
                    You no longer have access to an unavailable project. Remove
                    it to save this key.
                  </span>
                ) : null}
                {wasRestricted && selected.length === 0 ? (
                  <span role="status" className="text-text-2 text-[12px]">
                    No restriction is left: after saving, this key reaches all
                    your projects.
                  </span>
                ) : null}
              </div>
            );
          }}
        />
        {policyErrors.projectIds ? (
          <p className="text-danger text-[12px]">
            {policyErrors.projectIds.message}
          </p>
        ) : null}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        {children}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-rate-limit`}>
            Requests per minute{" "}
            <span className="text-text-muted font-normal">(optional)</span>
          </Label>
          <Input
            id={`${idPrefix}-rate-limit`}
            inputMode="numeric"
            placeholder="Default: 10000"
            aria-invalid={policyErrors.rateLimitPerMinute ? true : undefined}
            {...register("rateLimitPerMinute" as Path<T>)}
          />
          {policyErrors.rateLimitPerMinute ? (
            <p className="text-danger text-[12px]">
              {policyErrors.rateLimitPerMinute.message}
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
