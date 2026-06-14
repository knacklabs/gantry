import { DEEPAGENTS_ENGINE, type AgentEngine } from '../shared/agent-engine.js';
import {
  isRunCommandToolRule,
  publicGantryToolNameForSdkTool,
  RUN_COMMAND_TOOL_NAME,
} from '../shared/gantry-tool-facades.js';
import {
  resolveRuntimeSecurityPosture,
  type RuntimeSecurityEnv,
} from '../shared/security-posture.js';
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

// Locked plan copy. The literal lives here exactly once. It is the fail-closed
// message surfaced when a DeepAgents run requests shell/filesystem authority but
// the deployment posture or sandbox provider cannot enforce confinement.
export const DEEPAGENTS_ENFORCING_SANDBOX_REQUIRED_MESSAGE =
  'DeepAgents requires an enforcing sandbox before shell or filesystem tools can be enabled in this deployment mode.';

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

// Whether any resolved tool-policy rule would enable shell or filesystem
// authority for the run. Exported so callers can short-circuit before invoking
// the guard (e.g. to skip work when no such authority is requested).
export function requestsShellOrFilesystemAuthority(
  toolPolicyRules: readonly string[] | undefined,
): boolean {
  return (toolPolicyRules ?? []).some(
    (rule) =>
      ruleGrantsShellAuthority(rule) || ruleGrantsFilesystemAuthority(rule),
  );
}

export interface DeepAgentsShellFilesystemGuardInput {
  engine: AgentEngine;
  toolPolicyRules: readonly string[] | undefined;
  securityEnv: RuntimeSecurityEnv;
  sandboxProvider: RunnerSandboxProviderId | undefined;
}

// Whether the run's deployment posture + sandbox provider can enforce shell/
// filesystem confinement (protected-path denies + egress proxy). True only when
// the configured sandbox provider is the whole-runner OS sandbox AND the posture
// does not additionally require an enforcing sandbox that this one is not. In
// practice: `sandbox_runtime` always satisfies `requiresEnforcingSandbox`, so
// this collapses to "the sandbox is the enforcing OS sandbox". `direct` and any
// production/remote posture without `sandbox_runtime` cannot confine and so fail
// closed.
function deploymentCanEnforceShellSandbox(
  input: Pick<
    DeepAgentsShellFilesystemGuardInput,
    'securityEnv' | 'sandboxProvider'
  >,
): boolean {
  const posture = resolveRuntimeSecurityPosture(input.securityEnv);
  const sandboxIsEnforcing = input.sandboxProvider === 'sandbox_runtime';
  if (!sandboxIsEnforcing) return false;
  // sandbox_runtime is an enforcing sandbox; it satisfies a posture that
  // requires one. (The posture flag is kept explicit so the intent — "a posture
  // that demands enforcement is satisfied by an enforcing sandbox" — is clear.)
  return posture.requiresEnforcingSandbox || sandboxIsEnforcing;
}

// Pre-spawn guard for DeepAgents shell/filesystem authority. Truth table:
//   - non-DeepAgents engine                                   -> null (unaffected)
//   - DeepAgents, no shell/fs authority requested             -> null (no tool projected)
//   - DeepAgents + shell/fs authority + enforcing sandbox     -> null (allowed; runner
//                                                                projects the gated tool)
//   - DeepAgents + shell/fs authority + NOT enforcing sandbox -> locked enforcing-sandbox
//     (direct mode, or production/remote without sandbox_runtime)   copy (FAIL CLOSED)
// Shell/filesystem authority that is not backed by an enforcing sandbox is
// blocked; shell/filesystem with no shell/fs rule is simply not projected.
export function deepAgentsEnforcingSandboxGuard(
  input: DeepAgentsShellFilesystemGuardInput,
): string | null {
  if (input.engine !== DEEPAGENTS_ENGINE) return null;
  if (!requestsShellOrFilesystemAuthority(input.toolPolicyRules)) return null;
  if (deploymentCanEnforceShellSandbox(input)) return null;
  return DEEPAGENTS_ENFORCING_SANDBOX_REQUIRED_MESSAGE;
}

// Combined pre-spawn entry point. Returns the locked enforcing-sandbox message
// when a DeepAgents run requests shell/filesystem authority that cannot be
// confined, or null when the run is safe to spawn (no such authority, an
// enforcing sandbox, or a non-DeepAgents engine).
export function deepAgentsShellFilesystemGuard(
  input: DeepAgentsShellFilesystemGuardInput,
): string | null {
  return deepAgentsEnforcingSandboxGuard(input);
}

// Whether the host should project the Gantry-owned shell tool into the runner
// for this run: a DeepAgents run that requests shell (RunCommand/Bash) authority
// AND is confined by an enforcing sandbox. Derived from the SAME inputs the
// pre-spawn guard uses so the host env flag and the runner's projection agree;
// the guard already fails the spawn closed if shell authority is requested
// without an enforcing sandbox, so this only ever returns true on the allowed
// path. Filesystem-only authority does NOT enable the shell tool.
export function deepAgentsShellToolEnabled(
  input: DeepAgentsShellFilesystemGuardInput,
): boolean {
  if (input.engine !== DEEPAGENTS_ENGINE) return false;
  if (!requestsShellAuthority(input.toolPolicyRules)) return false;
  return deploymentCanEnforceShellSandbox(input);
}
