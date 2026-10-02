import { isPlainObject } from './object.js';
import {
  redactCredentials,
  sanitizeCredentialText,
  SENSITIVE_KEY_PATTERN,
} from './sensitive-material.js';

/** What a field named like a credential shows, whatever its value. */
export const HIDDEN = '[hidden]';

/**
 * Every tool-input field a permission prompt renders. Prompts render only
 * {@link permissionDisplayToolInput}'s projection of the input, and the
 * durable request snapshot stores that same projection, so a prompt
 * recovered after a restart shows exactly what the live one did.
 */
export const PERMISSION_DISPLAY_INPUT_KEYS: ReadonlySet<string> = new Set([
  // What runs: the command, its programs and the agent's description.
  'command',
  'cmd',
  'description',
  // Which capability, account, tool or file.
  'capabilityId',
  'capabilityDisplayName',
  'capabilityProposalKind',
  'accountLabel',
  'toolName',
  'toolNames',
  'file_path',
  'path',
  'pattern',
  'include',
  'url',
  'prompt',
  'selector',
  'text',
  'key',
  'old_string',
  'new_string',
  'content',
  // Scheduler.
  'job_id',
  'jobId',
  'name',
  'schedule',
  'schedule_value',
  'scheduleValue',
  // Skill installs and dependencies.
  'ecosystem',
  'packages',
  'reason',
  'activation',
  'commandArgv',
  'commandSummary',
  'files',
  'totalSizeBytes',
  'requiredEnvVars',
  'skillMarkdownPreview',
  // MCP servers.
  'transport',
  'origin',
  'requestedToolPatterns',
  'credentialNeeds',
  'networkHosts',
  // Agents, profiles and settings.
  'trigger',
  'requiresTrigger',
  'fileName',
  'file',
  'summary',
  'proposedContentHash',
  'proposedContentBytes',
  'proposedContent',
  'diffPreview',
  'replacementYaml',
  'expectedRevision',
  'authoritative',
  'agentCount',
  'providerIds',
  'diffSummary',
]);

// Internal runtime plumbing identifiers (chat jids, ipc dirs, run handles,
// sandbox/agent/skill ids) carry no decision value and can leak internal
// topology, so prompts never show them.
export function isInternalPlumbingKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.endsWith('jid') ||
    k.includes('ipcdir') ||
    k.includes('runhandle') ||
    k.includes('sandboxprofile') ||
    k.includes('workspacekey') ||
    k.includes('workspacefolder') ||
    k.endsWith('agentid') ||
    k.endsWith('appid') ||
    k.endsWith('sessionid') ||
    k.endsWith('threadid') ||
    k.endsWith('correlationid') ||
    k.endsWith('skillid') ||
    k.endsWith('profileid')
  );
}

// ponytail: head/tail cap above every prompt's own display window (at most
// 2400 head + 600 tail), so capping never changes what a prompt shows.
const STRING_HEAD = 3000;
const STRING_TAIL = 1000;
const MAX_ITEMS = 20;
const MAX_DEPTH = 2;

/** The tool input a permission prompt shows, with secrets hidden. */
export function permissionDisplayToolInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isPlainObject(input)) return undefined;
  const display: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isInternalPlumbingKey(key)) continue;
    const shown = PERMISSION_DISPLAY_INPUT_KEYS.has(key)
      ? displayValue(value, 0, key === 'command' || key === 'cmd')
      : SENSITIVE_KEY_PATTERN.test(key)
        ? HIDDEN
        : genericValue(value);
    if (shown !== undefined) display[key] = shown;
  }
  return Object.keys(display).length ? display : undefined;
}

function displayValue(value: unknown, depth: number, command = false): unknown {
  if (typeof value === 'string') return displayString(value, command);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ITEMS)
      .map((item) => displayValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_ITEMS)
      .map(
        ([key, item]) =>
          [
            key,
            SENSITIVE_KEY_PATTERN.test(key)
              ? HIDDEN
              : displayValue(item, depth + 1),
          ] as const,
      )
      .filter(([, item]) => item !== undefined),
  );
}

// Unknown tools render top-level scalars and scalar lists only.
function genericValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const scalars = value.filter(
      (item) => typeof item === 'string' || typeof item === 'number',
    );
    return scalars.length ? displayValue(scalars, 0) : undefined;
  }
  return typeof value === 'object' ? undefined : displayValue(value, 0);
}

/** Prompt text with secrets hidden, capped above every display window. */
export function permissionDisplayText(value: string): string {
  return displayString(value, false);
}

function displayString(value: string, command: boolean): string {
  const capped =
    value.length <= STRING_HEAD + STRING_TAIL + 1
      ? value
      : `${value.slice(0, STRING_HEAD)}…${value.slice(-STRING_TAIL)}`;
  // A command keeps its shape so its programs still show; other text is
  // hidden whole when an unrecognised secret-like token remains.
  if (command) return redactCredentials(capped);
  const result = sanitizeCredentialText(capped);
  return result.blocked ? 'Sensitive detail hidden.' : result.text;
}
