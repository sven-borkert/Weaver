"use client";

import { useState } from "react";
import { OIDC_PROVIDER_ID } from "@weaver/auth/constants";
import { useSearchParams } from "next/navigation";
import { authClient } from "~/lib/authClient";
import { withBasePath } from "~/lib/basePath";
import { AlertTriangle, ArrowRight, Lock, Shield } from "lucide-react";
import { toast } from "sonner";
import { LogoMark } from "~/components/brand/LogoMark";
import { safeLoginCallbackUrl } from "./callbackUrl";

export function LoginForm({
  oidcDisplayName,
}: { oidcDisplayName?: string } = {}) {
  const params = useSearchParams();
  const callbackUrl = safeLoginCallbackUrl(params.get("callbackUrl"));
  const [pending, setPending] = useState(false);
  const [oidcPending, setOidcPending] = useState(false);
  const busy = pending || oidcPending;

  return (
    <div className="bg-surface/95 border-line w-full max-w-[420px] rounded-2xl border p-6 shadow-(--sh-lg) sm:p-8">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-2.5">
          <LogoMark />
          <div className="min-w-0">
            <div className="text-text text-[15px] leading-tight font-semibold">
              Weaver
            </div>
            <div className="text-text-3 text-[12px]">Knowledge, connected</div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <h2
            className="text-text m-0 text-[22px] font-semibold"
            style={{ letterSpacing: "-0.018em" }}
          >
            Sign in to continue
          </h2>
          <p className="text-text-3 m-0 text-[13px] leading-[1.55]">
            {oidcDisplayName
              ? `Use ${oidcDisplayName} or your Weaver credentials.`
              : "Use your Weaver credentials."}{" "}
            Access is scoped per project.
          </p>
        </div>

        {params.has("error") && (
          <p role="alert" className="text-danger m-0 text-[13px]">
            Sign-in could not be completed. Please try again or use your Weaver
            credentials.
          </p>
        )}

        {oidcDisplayName && (
          <button
            type="button"
            disabled={busy}
            className="bg-surface border-line-strong text-text hover:bg-surface-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[8px] border px-4 py-2 text-[14px] font-medium disabled:cursor-progress disabled:opacity-60"
            onClick={async () => {
              setOidcPending(true);
              try {
                const errorParams = new URLSearchParams(params.toString());
                errorParams.delete("error");
                errorParams.delete("error_description");
                const query = errorParams.toString();
                const { data, error } = await authClient.signIn.social({
                  provider: OIDC_PROVIDER_ID,
                  callbackURL: withBasePath(callbackUrl),
                  errorCallbackURL: `${withBasePath("/login")}${query ? `?${query}` : ""}`,
                  disableRedirect: true,
                });
                if (error || !data?.url) {
                  toast.error(
                    error?.status === 429
                      ? "Too many sign-in attempts. Try again in a few seconds."
                      : "Could not start sign-in. Please try again.",
                  );
                  return;
                }
                window.location.assign(data.url);
              } catch {
                toast.error("Could not connect. Please try signing in again.");
              } finally {
                setOidcPending(false);
              }
            }}
          >
            <Shield size={16} aria-hidden="true" />
            {oidcPending ? "Connecting…" : `Sign in with ${oidcDisplayName}`}
          </button>
        )}

        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const emailValue = fd.get("email");
            const passwordValue = fd.get("password");
            const email = typeof emailValue === "string" ? emailValue : "";
            const password =
              typeof passwordValue === "string" ? passwordValue : "";
            setPending(true);
            try {
              const { data, error } = await authClient.signIn.email({
                email,
                password,
              });
              if (error) {
                toast.error(
                  error.status === 429
                    ? "Too many sign-in attempts. Try again in a few seconds."
                    : "Invalid credentials",
                );
                return;
              }
              // An OAuth authorization in progress answers with the next hop
              // (consent page or the client's redirect_uri) instead of a session-only result.
              const resume = data as {
                redirect?: boolean;
                url?: string;
              } | null;
              if (resume?.redirect && resume.url) {
                window.location.assign(resume.url);
                return;
              }
              window.location.assign(withBasePath(callbackUrl));
            } catch {
              toast.error("Could not connect. Please try signing in again.");
            } finally {
              setPending(false);
            }
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="email"
              className="text-text-2 text-[12px] font-medium"
              style={{ letterSpacing: "-0.005em" }}
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              className="bg-surface border-line-strong text-text placeholder:text-text-muted focus:border-brand h-9 rounded-[8px] border px-2.5 text-[13px] transition-shadow outline-none focus:shadow-(--sh-focus)"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="password"
              className="text-text-2 text-[12px] font-medium"
              style={{ letterSpacing: "-0.005em" }}
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="bg-surface border-line-strong text-text placeholder:text-text-muted focus:border-brand h-9 rounded-[8px] border px-2.5 text-[13px] transition-shadow outline-none focus:shadow-(--sh-focus)"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="bg-brand hover:bg-brand-hover disabled:bg-brand-pressed text-text-on-accent mt-1 inline-flex h-11 w-full items-center gap-3 rounded-[8px] border border-transparent px-4 text-[14px] font-medium transition-colors disabled:cursor-progress"
            style={{ letterSpacing: "-0.005em", boxShadow: "var(--sh-sm)" }}
          >
            <span className="bg-text-on-accent text-brand inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]">
              {pending ? (
                <span
                  className="inline-block h-[14px] w-[14px] rounded-full border-2"
                  style={{
                    borderColor: "var(--brand-border)",
                    borderTopColor: "var(--brand)",
                    animation: "weaver-spin 0.8s linear infinite",
                  }}
                />
              ) : (
                <Lock size={14} strokeWidth={1.75} />
              )}
            </span>
            <span className="flex-1 text-left">
              {pending ? "Signing in…" : "Sign in"}
            </span>
            {!pending && <ArrowRight size={15} strokeWidth={1.75} />}
          </button>
        </form>

        <div className="border-line bg-surface-2 flex flex-col gap-1.5 rounded-[6px] border px-3 py-2.5 text-[11.5px]">
          <div className="flex justify-between gap-2">
            <span className="text-text-3">Authentication</span>
            <span className="text-text-2">
              {oidcDisplayName ? "Password or single sign-on" : "Password"}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-text-3">Session</span>
            <span className="mono text-text-2">cookie · Better Auth</span>
          </div>
        </div>

        <div className="text-text-3 mt-1 flex items-center justify-between text-[11px]">
          <span className="text-text-3 inline-flex items-center gap-1">
            <AlertTriangle
              size={11}
              className="text-review-dot"
              strokeWidth={1.75}
            />
            Sign-ins are audited
          </span>
          <span>Weaver</span>
        </div>
      </div>
    </div>
  );
}
