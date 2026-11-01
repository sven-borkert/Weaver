#!/usr/bin/env node
// PreToolUse guard for .claude/settings.json (--mode=ask) and .codex/hooks.json
// (--mode=gate): gates the full integration suite / E2E. See CLAUDE.md rule #4.
import { readFileSync } from "node:fs";
import { needsTestConsent } from "./test-command-policy.mjs";

const mode = process.argv.includes("--mode=gate") ? "gate" : "ask";
const CONSENT = "RUN_FULL_TESTS";

let cmd = "";
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  cmd = String(payload?.tool_input?.command ?? "");
} catch {
  process.exit(0); // never block the agent on malformed input
}
if (!cmd) process.exit(0);

if (!needsTestConsent(cmd)) process.exit(0);

const reason =
  "Tier 3 test command (full integration suite ~15 min, or E2E rebuild). " +
  "Per CLAUDE.md rule #4: ask the user whether to run now or batch more " +
  `changes first. To run after the user agrees, prefix with ${CONSENT}=1.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: mode === "gate" ? "deny" : "ask",
      permissionDecisionReason: reason,
    },
  }),
);
process.exit(0);
