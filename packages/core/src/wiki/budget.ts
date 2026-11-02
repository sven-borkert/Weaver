import type { Edit, PatchAction } from "../documents/patch";

export type BudgetDelta = { grossCharsChanged: number; charsAdded: number };

export type BudgetDecision =
  { allowed: true } | { allowed: false; code: string; message: string };

export const WIKI_NON_OWNED_LIMITS = {
  findChars: 500,
  grossPerPage: 2_000,
  addedPerPage: 10_000,
  grossPerRun: 20_000,
  addedPerRun: 50_000,
} as const;

export const WIKI_BUDGET_REFUSALS_STOP_RUN = 3;
export const MAX_WIKI_OPERATION_N = 9_999;

/** Gross is what an edit replaces or removes, so a same-length rewrite counts in full. */
export function measurePatch(edits: readonly Edit[]): BudgetDelta {
  let grossCharsChanged = 0;
  let charsAdded = 0;
  for (const edit of edits) {
    grossCharsChanged += edit.end - edit.start;
    charsAdded += edit.text.length;
  }
  return { grossCharsChanged, charsAdded };
}

export function measureCreate(markdown: string): BudgetDelta {
  return { grossCharsChanged: 0, charsAdded: markdown.length };
}

function refuse(code: string, message: string): BudgetDecision {
  return { allowed: false, code, message };
}

/** Shape limits on a page the agent does not own, before any counting. */
export function checkNonOwnedActions(
  actions: readonly PatchAction[],
): BudgetDecision {
  for (const action of actions) {
    if (
      action.action === "remove_section" ||
      action.action === "replace_section_body"
    )
      return refuse(
        "SECTION_ACTION_NOT_OWNED",
        `${action.action} is only available on pages the agent owns; patch this page with replace_text or an insert`,
      );
    if (action.action !== "replace_text") continue;
    if (action.find.length > WIKI_NON_OWNED_LIMITS.findChars)
      return refuse(
        "FIND_TOO_LONG",
        `find may be at most ${WIKI_NON_OWNED_LIMITS.findChars} characters on a page the agent does not own`,
      );
    if ((action.expectedMatches ?? 1) !== 1)
      return refuse(
        "EXPECTED_MATCHES",
        "expectedMatches must be 1 on a page the agent does not own",
      );
  }
  return { allowed: true };
}

/** Owned pages are unlimited here; the page and run counters hold non-owned writes only. */
export function checkBudget(input: {
  owned: boolean;
  page: BudgetDelta;
  run: BudgetDelta;
  delta: BudgetDelta;
}): BudgetDecision {
  if (input.owned) return { allowed: true };
  const { page, run, delta } = input;
  const limits = WIKI_NON_OWNED_LIMITS;
  if (page.grossCharsChanged + delta.grossCharsChanged > limits.grossPerPage)
    return refuse(
      "PAGE_GROSS_BUDGET",
      `This would replace more than ${limits.grossPerPage} existing characters on a page the agent does not own in this run`,
    );
  if (page.charsAdded + delta.charsAdded > limits.addedPerPage)
    return refuse(
      "PAGE_ADDED_BUDGET",
      `This would add more than ${limits.addedPerPage} characters to a page the agent does not own in this run`,
    );
  if (run.grossCharsChanged + delta.grossCharsChanged > limits.grossPerRun)
    return refuse(
      "RUN_GROSS_BUDGET",
      `This would replace more than ${limits.grossPerRun} existing characters across pages the agent does not own in this run`,
    );
  if (run.charsAdded + delta.charsAdded > limits.addedPerRun)
    return refuse(
      "RUN_ADDED_BUDGET",
      `This would add more than ${limits.addedPerRun} characters across pages the agent does not own in this run`,
    );
  return { allowed: true };
}

export function formatWikiOperationId(
  prefix: "wiki-run" | "wiki-revert",
  runId: string,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_WIKI_OPERATION_N)
    throw new RangeError("wiki operation number out of range");
  return `${prefix}:${runId}:${String(n).padStart(4, "0")}`;
}
