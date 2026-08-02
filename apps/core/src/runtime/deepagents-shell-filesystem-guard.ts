import { DEEPAGENTS_ENGINE, type AgentEngine } from '../shared/agent-engine.js';
import {
  isRunCommandToolRule,
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from '../shared/gantry-tool-facades.js';
import type { RuntimeSecurityEnv } from '../shared/security-posture.js';
import type { RunnerSandboxProviderId } from '../shared/runner-sandbox-provider.js';

// Host-side, pre-spawn guards for DeepAgents runs that request shell (Bash /
// RunCommand) or SDK filesystem-tool authority. Shell/filesystem authority on
// the DeepAgents lane is enabled ONLY through a Gantry-owned, policy-gated,
// sandbox-confined tool (a `RunCommand`-named LangChain tool injected into the
// graph and wrapped with the neutral permission gate). Raw DeepAgents `execute`
// and the baked-in filesystem tools stay disabled (StateBackend +
// DENY_ALL_FILESYSTEM in the runner). These guards are pure functions so the
// truth table and exact locked-plan copy are unit-testable without spawning a
// runner. See docs/architecture/deepagents-agent-engine-handoff-plan.md.

// Gantry facade filesystem tools plus their provider-native source names; any of
// these in a resolved tool rule grants SDK filesystem authority. RunCommand /
// Bash shell authority is detected separately so the canonical Browser facade
// and pure web/search tools never trip the guard.
const FILESYSTEM_AUTHORITY_TOOL_NAMES = new Set<string>([
  'FileRead',
  'FileWrite',
  'FileEdit',
  'FileSearch',
]);

function ruleHeadName(rule: string): string {
  const trimmed = rule.trim();
  const open = trimmed.indexOf('(');
  const head = open >= 0 ? trimmed.slice(0, open) : trimmed;
  return head.trim();
}

// True when a single resolved tool-policy rule would grant shell execution
// (Bash or RunCommand, bare or scoped) for the run.
function ruleGrantsShellAuthority(rule: string): boolean {
  if (isRunCommandToolRule(rule)) return true;
  // Provider-native Bash maps to RunCommand; catch the raw alias too.
  return publicGantryToolNameForSdkTool(ruleHeadName(rule)).startsWith(
    RUN_COMMAND_TOOL_NAME,
  );
}

// True when a single resolved tool-policy rule would grant SDK filesystem-tool
// authority (Gantry FileRead/FileWrite/FileEdit/FileSearch or their raw
// provider-native source names such as Read/Write/Edit/MultiEdit/Glob/Grep).
function ruleGrantsFilesystemAuthority(rule: string): boolean {
  const head = ruleHeadName(rule);
  if (FILESYSTEM_AUTHORITY_TOOL_NAMES.has(head)) return true;
  return FILESYSTEM_AUTHORITY_TOOL_NAMES.has(
    publicGantryToolNameForSdkTool(head),
  );
}

// Whether any resolved tool-policy rule would grant shell (RunCommand/Bash)
// authority for the run. The Gantry-owned shell tool is projected only when this
// is true (and the run is confined by an enforcing sandbox).
export function requestsShellAuthority(
  toolPolicyRules: readonly string[] | undefined,
): boolean {
  return (toolPolicyRules ?? []).some(ruleGrantsShellAuthority);
}

export function requestsFilesystemAuthority(
  toolPolicyRules: readonly string[] | undefined,
): boolean {
  return (toolPolicyRules ?? []).some(ruleGrantsFilesystemAuthority);
}

// Whether any resolved tool-policy rule would enable shell or filesystem
// authority for the run. Exported so callers can short-circuit before invoking
// the guard (e.g. to skip work when no such authority is requested).
export function requestsShellOrFilesystemAuthority(
  toolPolicyRules: readonly string[] | undefined,
): boolean {
  return (
    requestsShellAuthority(toolPolicyRules) ||
    requestsFilesystemAuthority(toolPolicyRules)
  );
}

export interface DeepAgentsShellFilesystemGuardInput {
  engine: AgentEngine;
  toolPolicyRules: readonly string[] | undefined;
  securityEnv: RuntimeSecurityEnv;
  sandboxProvider: RunnerSandboxProviderId | undefined;
}

// Two-axis model (decision 0040): the sandbox provider does NOT gate DeepAgents
// shell/filesystem tool projection. Authorization is the control in BOTH modes —
// the Gantry-owned RunCommand tool is gated by its tool rule + the host
// coordinator. `sandbox_runtime` additionally confines the run with the OS jail;
// `direct` relies on authorization + the deployment boundary. So shell/File tools
// are projected for any DeepAgents run that requests the authority, in either mode
// — there is no enforcing-sandbox fail-closed anymore.

// Pre-spawn guard entry point. Kept as a stable no-op so callers keep their
// guard-check shape; nothing is fail-closed on the sandbox provider now.
export function deepAgentsShellFilesystemGuard(
  _input: DeepAgentsShellFilesystemGuardInput,
): string | null {
  return null;
}

// Whether the host should project the Gantry-owned shell tool: a DeepAgents run
// that requests shell (RunCommand/Bash) authority. Filesystem-only authority does
// NOT enable the shell tool.
export function deepAgentsShellToolEnabled(
  input: DeepAgentsShellFilesystemGuardInput,
): boolean {
  return (
    input.engine === DEEPAGENTS_ENGINE &&
    requestsShellAuthority(input.toolPolicyRules)
  );
}

// Whether the host should mount Gantry-owned File* facade tools for a DeepAgents
// run (each File* action is still gated by run-time approval).
export function deepAgentsFilesystemToolsEnabled(
  input: DeepAgentsShellFilesystemGuardInput,
): boolean {
  return input.engine === DEEPAGENTS_ENGINE;
}
