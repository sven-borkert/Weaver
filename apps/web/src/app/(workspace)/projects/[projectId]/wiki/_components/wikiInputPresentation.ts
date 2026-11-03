import type {
  WikiInputView,
  WikiRunView,
} from "@weaver/core/services/wikiInputs";

export const WIKI_INPUT_ACCEPT =
  ".pdf,.docx,.xlsx,.csv,.md,.markdown,.txt,application/pdf,text/csv,text/markdown,text/plain";

const STATUS_LABELS: Record<WikiInputView["status"], string> = {
  queued: "Queued",
  preparing: "Preparing",
  ready: "Ready",
  processing: "Processing",
  processed: "Processed",
  skipped: "Skipped",
  held: "Possible secret",
  failed: "Failed",
  reverted: "Reverted",
  removed: "Removed",
};

export function wikiStatusLabel(status: WikiInputView["status"]): string {
  return STATUS_LABELS[status];
}

const HIT_LABELS: Record<string, string> = {
  pem_private_key: "private key",
  aws_access_key: "AWS access key",
  aws_secret_key: "AWS secret key",
  gcp_service_account: "Google service account",
  gcp_api_key: "Google API key",
  azure_storage_key: "Azure storage key",
  github_token: "GitHub token",
  gitlab_token: "GitLab token",
  slack_token: "Slack token",
  slack_webhook: "Slack webhook",
  stripe_key: "Stripe key",
  jwt: "JSON web token",
  url_credentials: "credentials in a URL",
  credential_assignment: "password or token",
  iban: "bank account number",
  card_number: "card number",
};

export function wikiHitLabel(hit: { kind: string; location: string }): string {
  return `${HIT_LABELS[hit.kind] ?? "secret"} (${hit.location})`;
}

/** What the last run means for the person looking at the queue, in plain words. */
export function wikiRunNotice(run: WikiRunView | null): {
  tone: "info" | "warn";
  message: string;
} | null {
  if (!run) return null;
  if (run.errorCode === "RUNNER_UNAVAILABLE")
    return {
      tone: "warn",
      message:
        "Sources were prepared and kept, but the worker that picked this up cannot run the wiki agent, so nothing was integrated into wiki pages. Your inputs are back in the queue and will reuse their sources. Ask an administrator to check the worker.",
    };
  if (run.errorCode === "NO_WORKER")
    return {
      tone: "warn",
      message:
        "No worker is consuming wiki runs, so the last run was cancelled and its inputs returned to the queue. Ask an administrator to enable the wiki worker role.",
    };
  if (run.status === "stopped" && run.stopReason === "no_ready_items")
    return {
      tone: "info",
      message:
        "The last run had nothing to integrate. Check the inputs under Needs attention.",
    };
  if (run.status === "stopped")
    return {
      tone: "info",
      message:
        "The last run stopped before finishing and returned what it had not finished to the queue. The Runs tab says why.",
    };
  if (run.status === "failed")
    return {
      tone: "warn",
      message: run.errorMessage ?? "The last run failed.",
    };
  if (run.status === "cancelled")
    return { tone: "info", message: "The last run was cancelled." };
  return null;
}

export function wikiActiveRunLabel(run: WikiRunView): string {
  if (run.status === "preparing") return "Preparing sources";
  if (run.status === "queued") return "Waiting for a worker";
  return "Running";
}

/** The next Process takes this many; the rest stay queued. */
export function wikiProcessCount(
  queued: number,
  selected: number,
  batchLimit: number,
): { take: number; left: number } {
  const wanted = selected > 0 ? selected : queued;
  const take = Math.min(wanted, batchLimit);
  return { take, left: queued - take };
}
