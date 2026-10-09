import {
  ADMIN_MCP_TOOL_NAMES,
  ALL_GANTRY_MCP_TOOL_NAMES,
  ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  RECOVERY_PROPOSAL_GANTRY_MCP_TOOL_NAMES,
  BASELINE_GANTRY_MCP_TOOL_NAMES,
  DEFAULT_GANTRY_MCP_TOOL_NAMES,
  DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  GATED_GANTRY_MCP_TOOL_NAMES,
  OPTIONAL_GANTRY_MCP_TOOL_NAMES,
  REVIEWED_GANTRY_MCP_TOOL_NAMES,
  SCHEDULER_MUTATION_MCP_TOOL_NAMES,
  adminMcpToolNameFromFullName,
} from './admin-mcp-tools.js';
import {
  selectedMemoryIpcActionsFromToolRules,
  type GantryMemoryIpcAction,
  type MemoryIpcActionSelectionOptions,
} from './memory-ipc-actions.js';
import { isCanonicalBrowserCapabilityRule } from './agent-tool-references.js';
import { applyProviderAffinity } from './gantry-tool-provider-affinity.js';
import {
  GANTRY_FACADE_EXACT_TOOL_NAMES,
  RUN_COMMAND_TOOL_NAME,
  publicGantryToolNameForSdkTool,
} from './gantry-tool-facades.js';

// Authority-changing Gantry tools let an agent request new install/setup/access
// authority for itself. In the fixed-image worker product mode they are hidden
// from user-facing live agents and scheduled jobs: workers never install tools,
// skills, MCP servers, or dependencies during a run. Admin tools are tracked
// separately in ADMIN_MCP_TOOL_NAMES. The canonical constants live in shared;
// selection and registration read the same canonical names.
export {
  ALL_GANTRY_MCP_TOOL_NAMES,
  ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  BASELINE_GANTRY_MCP_TOOL_NAMES,
  DEFAULT_GANTRY_MCP_TOOL_NAMES,
  DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  GATED_GANTRY_MCP_TOOL_NAMES,
  OPTIONAL_GANTRY_MCP_TOOL_NAMES,
  REVIEWED_GANTRY_MCP_TOOL_NAMES,
};

const REVIEWER_MEMORY_REVIEW_GANTRY_MCP_TOOL_NAMES = [
  'memory_review_pending',
  'memory_review_decision',
] as const;

export const NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES = [
  ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  ...OPTIONAL_GANTRY_MCP_TOOL_NAMES,
  ...REVIEWED_GANTRY_MCP_TOOL_NAMES,
] as const;

const AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
);

const NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(
  NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES,
);

const ADMIN_MCP_TOOL_NAME_SET = new Set<string>(ADMIN_MCP_TOOL_NAMES);
export function isAuthorityChangingGantryMcpToolName(value: string): boolean {
  return AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET.has(value);
}

export function isNoPermissionHiddenGantryMcpToolName(value: string): boolean {
  return NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET.has(value);
}

const ALL_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(ALL_GANTRY_MCP_TOOL_NAMES);

export interface GantryMcpToolSelectionOptions extends MemoryIpcActionSelectionOptions {
  accessPreset?: 'full' | 'locked';
  browserIpcEnabled?: boolean;
  // When true, omit authority-changing request tools from the projected surface
  // (fixed-image worker / no-permission-tools mode).
  excludeAuthorityTools?: boolean;
  // Async command task tools require a durable task repository and an enforcing
  // runner sandbox. They are projected only when the host says that executor is
  // available for this run.
  asyncTaskToolsEnabled?: boolean;
  chatJid?: string;
  permissionLane?: 'interactive' | 'autonomous';
  // Fixed-image (no-permission) workers keep the birthright recovery
  // proposals visible (0123); LOCKED agents never set this — locked means
  // never raising an approval prompt.
  keepRecoveryProposals?: boolean;
}

export function gantryMcpFullToolName(toolName: string): string {
  return `mcp__gantry__${toolName}`;
}

export function selectedAdminMcpToolNames(
  configuredTools: readonly string[],
): string[] {
  const names = new Set<string>();
  for (const configuredTool of configuredTools) {
    const name = adminMcpToolNameFromFullName(configuredTool.trim());
    if (name) names.add(name);
  }
  return [...names].sort();
}

export function gantryMcpToolNameFromFullName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('mcp__gantry__')) return null;
  const toolName = trimmed.slice('mcp__gantry__'.length);
  return ALL_GANTRY_MCP_TOOL_NAME_SET.has(toolName) ? toolName : null;
}

export function selectedGantryMcpToolNames(
  configuredTools: readonly string[],
  options: GantryMcpToolSelectionOptions = {},
): string[] {
  if (options.accessPreset === 'locked') {
    options = {
      ...options,
      excludeAuthorityTools: true,
      keepRecoveryProposals: false,
    };
  }
  const names = new Set<string>(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  if (options.asyncTaskToolsEnabled && !options.excludeAuthorityTools) {
    for (const toolName of ASYNC_TASK_GANTRY_MCP_TOOL_NAMES)
      names.add(toolName);
    if (configuredTools.includes('AgentDelegation')) {
      for (const toolName of DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES)
        names.add(toolName);
    }
  }
  if (
    isBrowserSelected(configuredTools) &&
    options.browserIpcEnabled !== false
  ) {
    for (const toolName of GATED_GANTRY_MCP_TOOL_NAMES) names.add(toolName);
  }
  if (options.memoryReviewerIsControlApprover) {
    for (const toolName of REVIEWER_MEMORY_REVIEW_GANTRY_MCP_TOOL_NAMES) {
      names.add(toolName);
    }
  }
  for (const configuredTool of configuredTools) {
    const name = gantryMcpToolNameFromFullName(configuredTool);
    if (
      name &&
      (options.asyncTaskToolsEnabled ||
        ![
          ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
          ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
        ].includes(name as never)) &&
      !(GATED_GANTRY_MCP_TOOL_NAMES as readonly string[]).includes(name)
    ) {
      names.add(name);
    }
  }
  if (options.excludeAuthorityTools) {
    for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
      names.delete(toolName);
    }
    for (const toolName of ADMIN_MCP_TOOL_NAMES) {
      names.delete(toolName);
    }
    if (options.keepRecoveryProposals) {
      // Recovery proposals stay visible (0123): birthright review-metadata
      // tools raise no worker-side prompt, and hiding them leaves autonomous
      // runs unable to ask for fixes (the CAPFIX-1 card could never be
      // raised). Locked agents never pass this flag.
      for (const toolName of RECOVERY_PROPOSAL_GANTRY_MCP_TOOL_NAMES) {
        names.add(toolName);
      }
    }
    if (options.accessPreset !== 'locked') {
      for (const name of selectedAdminMcpToolNames(configuredTools))
        names.add(name);
    }
  }
  if (options.permissionLane === 'autonomous') {
    for (const toolName of SCHEDULER_MUTATION_MCP_TOOL_NAMES) {
      names.delete(toolName);
    }
  }
  return [...applyProviderAffinity(names, options.chatJid)].sort();
}

export function renderGantryMcpToolAvailability(
  configuredTools: readonly string[],
  options: GantryMcpToolSelectionOptions,
  callableToolNames: readonly string[] = [],
  mountedNames?: ReadonlySet<string>,
  facadeUnavailableReasons: Readonly<Record<string, string>> = {},
): string {
  const selected = completeGantryToolNames([
    ...(mountedNames ?? selectedGantryMcpToolNames(configuredTools, options)),
    ...callableToolNames,
  ]);
  const unavailable = new Map<string, string[]>();
  const selectedAdminNames = new Set(
    selectedAdminMcpToolNames(configuredTools),
  );
  for (const name of new Set([
    ...ALL_GANTRY_MCP_TOOL_NAMES,
    ...GANTRY_FACADE_EXACT_TOOL_NAMES,
    RUN_COMMAND_TOOL_NAME,
  ])) {
    if (selected.has(name)) continue;
    const hidden =
      NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET.has(name) ||
      ADMIN_MCP_TOOL_NAME_SET.has(name) ||
      name === 'AgentDelegation';
    const task =
      name === 'AgentDelegation' ||
      [
        ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
        ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
      ].includes(name as never);
    const browser = (GATED_GANTRY_MCP_TOOL_NAMES as readonly string[]).includes(
      name,
    );
    let reason =
      facadeUnavailableReasons[name] ?? 'not selected for this agent';
    if (ADMIN_MCP_TOOL_NAME_SET.has(name) && !selectedAdminNames.has(name)) {
      reason = 'not selected for this agent';
    } else if (options.accessPreset === 'locked' && hidden) {
      reason = 'locked access preset';
    } else if (options.excludeAuthorityTools && hidden) {
      reason = 'tools are hidden for this run';
    } else if (task && !options.asyncTaskToolsEnabled) {
      reason = 'async task executor is unavailable';
    } else if (
      (name === 'AgentDelegation' ||
        (DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES as readonly string[]).includes(
          name,
        )) &&
      !configuredTools.includes('AgentDelegation')
    ) {
      reason = 'AgentDelegation has not been granted';
    } else if (browser && !isBrowserSelected(configuredTools)) {
      reason = 'Browser has not been granted';
    } else if (browser && options.browserIpcEnabled === false) {
      reason = 'browser IPC is unavailable';
    } else if (
      options.permissionLane === 'autonomous' &&
      (SCHEDULER_MUTATION_MCP_TOOL_NAMES as readonly string[]).includes(name)
    ) {
      reason = 'scheduler mutations are unavailable in autonomous runs';
    } else if (!applyProviderAffinity([name], options.chatJid).has(name)) {
      reason = 'unavailable on this conversation provider';
    }
    const names = unavailable.get(reason) ?? [];
    names.push(name);
    unavailable.set(reason, names);
  }
  return [
    '## Gantry tools in this run',
    `Available: ${[...selected].sort().join(', ')}.`,
    ...[...unavailable].map(
      ([reason, names]) => `Unavailable: ${names.join(', ')} — ${reason}.`,
    ),
    'Use this list to determine availability; do not infer absence from deferred tool discovery.',
    'Available lists exposed tools; execution still passes through Gantry permission checks.',
  ].join('\n');
}

function isBrowserSelected(configuredTools: readonly string[]): boolean {
  return configuredTools.some(isCanonicalBrowserCapabilityRule);
}

export function selectedGantryMcpFullToolNames(
  configuredTools: readonly string[],
  options: GantryMcpToolSelectionOptions = {},
): string[] {
  return selectedGantryMcpToolNames(configuredTools, options).map(
    gantryMcpFullToolName,
  );
}

export function completeGantryToolNames(
  gantryNames: Iterable<string>,
  nativeNames: Iterable<string> = [],
): Set<string> {
  return new Set([
    ...Array.from(gantryNames, (name) => name.replace(/^mcp__gantry__/, '')),
    ...Array.from(nativeNames, publicGantryToolNameForSdkTool),
  ]);
}

export function withMountedGantryToolNames(
  prompt: string | undefined,
  mountedNames: ReadonlySet<string>,
  configuredTools: readonly string[] = [],
  mountEnv?: Readonly<Record<string, string | undefined>>,
  facadeUnavailableReasons: Readonly<Record<string, string>> = {},
): string {
  const compiled = prompt ?? '';
  // Inline callers supply their own gate guidance; worker callers use MCP mount evidence.
  const availability = mountEnv
    ? renderGantryMcpToolAvailability(
        configuredTools,
        {
          accessPreset:
            mountEnv.GANTRY_AGENT_ACCESS_PRESET === 'locked'
              ? 'locked'
              : 'full',
          excludeAuthorityTools: mountEnv.GANTRY_NO_PERMISSION_TOOLS === '1',
          browserIpcEnabled: Boolean(
            mountEnv.GANTRY_BROWSER_IPC_AUTH_TOKEN?.trim(),
          ),
          asyncTaskToolsEnabled:
            mountEnv.GANTRY_ASYNC_TASK_TOOLS_ENABLED === '1',
          chatJid: mountEnv.GANTRY_CHAT_JID,
          permissionLane:
            mountEnv.GANTRY_PERMISSION_LANE === 'interactive'
              ? 'interactive'
              : 'autonomous',
        },
        [],
        mountedNames,
        facadeUnavailableReasons,
      )
    : `## Gantry tools in this run\nAvailable: ${[...mountedNames].sort().join(', ')}.`;
  const heading = compiled.lastIndexOf('## Gantry tools in this run\n');
  if (heading < 0) return [prompt, availability].filter(Boolean).join('\n\n');
  const section = mountEnv
    ? /^## Gantry tools in this run\nAvailable:[^\n]*(?:\nUnavailable:[^\n]*)*/
    : /^## Gantry tools in this run\nAvailable:[^\n]*/;
  return (
    compiled.slice(0, heading) +
    compiled.slice(heading).replace(section, () => availability)
  );
}

// Locked agents start from the default surface minus every authority-changing
// and admin tool. This is the fail-closed base: an unset or corrupt env can
// never restore authority tools for a locked agent.
function lockedDefaultGantryMcpToolNames(): Set<string> {
  const names = new Set<string>(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
    names.delete(toolName);
  }
  for (const toolName of ADMIN_MCP_TOOL_NAMES) {
    names.delete(toolName);
  }
  return names;
}

export function parseEnabledGantryMcpToolNames(
  raw: string | undefined,
  options: {
    lockedPreset?: boolean;
    chatJid?: string;
    permissionLane?: 'interactive' | 'autonomous';
  } = {},
): Set<string> {
  // For locked agents a malformed/unset env must fail closed to the locked
  // base set, never to the full default set that still carries authority tools.
  const applyRunRestrictions = (names: Set<string>): Set<string> => {
    if (options.permissionLane === 'autonomous') {
      for (const toolName of SCHEDULER_MUTATION_MCP_TOOL_NAMES) {
        names.delete(toolName);
      }
    }
    return names;
  };
  const fallback = (): Set<string> =>
    applyRunRestrictions(
      applyProviderAffinity(
        options.lockedPreset
          ? lockedDefaultGantryMcpToolNames()
          : DEFAULT_GANTRY_MCP_TOOL_NAMES,
        options.chatJid,
      ),
    );
  const base = (): Set<string> =>
    options.lockedPreset
      ? lockedDefaultGantryMcpToolNames()
      : new Set<string>(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  if (!raw?.trim()) {
    return fallback();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return fallback();
    }
    const enabled = base();
    for (const item of parsed) {
      const toolName = typeof item === 'string' ? item.trim() : '';
      if (!ALL_GANTRY_MCP_TOOL_NAME_SET.has(toolName)) continue;
      if (
        options.lockedPreset &&
        (NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET.has(toolName) ||
          ADMIN_MCP_TOOL_NAME_SET.has(toolName))
      ) {
        continue;
      }
      enabled.add(toolName);
    }
    return applyRunRestrictions(
      applyProviderAffinity(enabled, options.chatJid),
    );
  } catch {
    return fallback();
  }
}

export function selectedMemoryIpcActions(
  configuredTools: readonly string[],
  options: GantryMcpToolSelectionOptions = {},
): GantryMemoryIpcAction[] {
  return selectedMemoryIpcActionsFromToolRules(configuredTools, options);
}
