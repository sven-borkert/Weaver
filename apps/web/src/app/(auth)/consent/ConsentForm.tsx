"use client";

import { AlertTriangle, Check, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/authClient";
import { describeScope } from "./scopeDescriptions";

export function ConsentForm(props: {
  clientId: string;
  clientName: string;
  redirectUri: string | null;
  resource: string;
  scopes: string[];
  userEmail: string;
}) {
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const grantsWrite = props.scopes.some((scope) => describeScope(scope).write);

  async function decide(accept: boolean) {
    setPending(accept ? "allow" : "deny");
    try {
      // The OAuth client plugin appends the page's signed oauth_query automatically.
      const { data, error } = await authClient.oauth2.consent({ accept });
      const result = data as { url?: string; redirect_uri?: string } | null;
      const target = result?.url ?? result?.redirect_uri;
      if (error || !target) {
        toast.error(
          "Could not record your decision. Start again from the client.",
        );
        return;
      }
      window.location.assign(target);
    } catch {
      toast.error(
        "Could not connect. Please try recording your decision again.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      aria-labelledby="consent-title"
      className="border-line bg-surface/95 flex w-full max-w-[440px] flex-col gap-5 rounded-2xl border p-6 shadow-(--sh-lg)"
      style={{ boxShadow: "var(--sh-sm)" }}
    >
      <div className="flex flex-col gap-1.5">
        <h1
          id="consent-title"
          className="text-text m-0 text-[20px] font-semibold"
        >
          Allow {props.clientName} to access Weaver?
        </h1>
        <p className="text-text-3 m-0 text-[13px] leading-[1.55]">
          Signed in as <span className="text-text-2">{props.userEmail}</span>.
          The client will act as you, limited to the permissions below and to
          projects you belong to.
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {props.scopes.map((scope) => {
          const description = describeScope(scope);
          return (
            <li
              key={scope}
              className="border-line-faint flex items-start gap-2.5 rounded-[6px] border px-3 py-2"
            >
              {description.write ? (
                <AlertTriangle
                  className="text-danger mt-0.5 size-4 shrink-0"
                  aria-hidden
                />
              ) : (
                <Check
                  className="text-brand mt-0.5 size-4 shrink-0"
                  aria-hidden
                />
              )}
              <div className="flex flex-col">
                <span className="text-text text-[13px] font-medium">
                  {description.title}
                </span>
                <span className="text-text-3 text-[12px]">
                  {description.detail}
                </span>
                <code className="text-text-muted mt-0.5 text-[11px]">
                  {scope}
                </code>
              </div>
            </li>
          );
        })}
      </ul>

      {grantsWrite ? (
        <p className="border-danger/40 bg-danger/5 text-text-2 m-0 rounded-[6px] border px-3 py-2 text-[12px]">
          This client asks to edit content directly. Changes are saved under
          your name without a review step.
        </p>
      ) : null}

      <dl className="text-text-3 m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <dt>Client</dt>
        <dd className="mono text-text-2 m-0 break-all">{props.clientId}</dd>
        <dt>Resource</dt>
        <dd className="mono text-text-2 m-0 break-all">{props.resource}</dd>
        {props.redirectUri ? (
          <>
            <dt>Returns to</dt>
            <dd className="mono text-text-2 m-0 break-all">
              {props.redirectUri}
            </dd>
          </>
        ) : null}
      </dl>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void decide(false)}
        >
          <X data-icon="inline-start" />
          {pending === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button
          type="button"
          disabled={pending !== null}
          onClick={() => void decide(true)}
        >
          <Check data-icon="inline-start" />
          {pending === "allow" ? "Allowing…" : "Allow access"}
        </Button>
      </div>
    </section>
  );
}
