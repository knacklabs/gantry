import { isPlainObject } from './object.js';
import {
  detectPotentialUnredactedSecret,
  redactCredentials,
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
// The tool input object, its fields, and two levels inside them.
const MAX_DEPTH = 3;
const COMMAND_KEYS = new Set(['command', 'cmd']);
export const SENSITIVE_DETAIL_HIDDEN = 'Sensitive detail hidden.';

export interface PermissionPromptSafeOptions {
  /** Characters kept from the start and end when text is shortened. */
  head?: number;
  tail?: number;
  /** A command keeps its shape (its programs must still show) and is cut at
   *  line ends; other text is hidden whole when a secret-like token remains. */
  command?: boolean;
  /** A field whose credential-like name is not a credential (a browser
   *  keyboard key). */
  keepKey?: (key: string) => boolean;
}

/**
 * The one way permission-prompt content is made safe, whether it is shown or
 * stored, in this order:
 * 1. fields named like a credential are hidden at any depth, and in text the
 *    credential fields (`KEY=value`, `key: value`, JSON `"key": "value"`) and
 *    URL user:password are masked;
 * 2. then remaining secret-looking values are masked by pattern;
 * 3. only then is the result shortened.
 */
export function permissionPromptSafe(
  value: string,
  options?: PermissionPromptSafeOptions,
): string;
export function permissionPromptSafe(
  value: unknown,
  options?: PermissionPromptSafeOptions,
): unknown;
export function permissionPromptSafe(
  value: unknown,
  options: PermissionPromptSafeOptions = {},
): unknown {
  return promptSafeValue(value, options, 0);
}

function promptSafeValue(
  value: unknown,
  options: PermissionPromptSafeOptions,
  depth: number,
): unknown {
  if (typeof value === 'string') return promptSafeText(value, options);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return undefined;
  const child = { ...options, command: false };
  if (Array.isArray(value)) {
    return value
      .map((item) => promptSafeValue(item, child, depth + 1))
      .filter((item) => item !== undefined)
      .slice(0, MAX_ITEMS);
  }
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .map(
        ([key, item]) =>
          [
            key,
            SENSITIVE_KEY_PATTERN.test(key) && !options.keepKey?.(key)
              ? HIDDEN
              : promptSafeValue(
                  item,
                  { ...child, command: COMMAND_KEYS.has(key) },
                  depth + 1,
                ),
          ] as const,
      )
      .filter(([, item]) => item !== undefined)
      .slice(0, MAX_ITEMS),
  );
}

function promptSafeText(
  text: string,
  options: PermissionPromptSafeOptions,
): string {
  const head = options.head ?? STRING_HEAD;
  const tail = options.tail ?? STRING_TAIL;
  // Steps 1 and 2 over the whole text, so shortening can't split a secret
  // from the name that identifies it.
  const redacted = redactCredentials(text);
  if (options.command) return clampCommandForDisplay(redacted, head, tail);
  if (detectPotentialUnredactedSecret(redacted)) return SENSITIVE_DETAIL_HIDDEN;
  return headTailTruncate(redacted, head, tail);
}

/** The tool input a permission prompt shows, with secrets hidden. */
export function permissionDisplayToolInput(
  input: Record<string, unknown> | undefined,
  toolName?: string,
): Record<string, unknown> | undefined {
  if (!isPlainObject(input)) return undefined;
  const selected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isInternalPlumbingKey(key)) continue;
    // Unknown fields show only scalars and scalar lists.
    selected[key] = PERMISSION_DISPLAY_INPUT_KEYS.has(key)
      ? value
      : genericValue(value);
  }
  const keyboardKey = toolName?.startsWith('mcp__gantry__browser_') === true;
  const display = permissionPromptSafe(selected, {
    // Named like credentials but never one: a browser keyboard key, and the
    // names of credentials an MCP server needs.
    keepKey: (key) =>
      (keyboardKey && key === 'key') || key === 'credentialNeeds',
  }) as Record<string, unknown>;
  return Object.keys(display).length ? display : undefined;
}

function genericValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const scalars = value.filter(
      (item) => typeof item === 'string' || typeof item === 'number',
    );
    return scalars.length ? scalars : undefined;
  }
  return typeof value === 'object' ? undefined : value;
}

export function headTailTruncate(
  input: string,
  head: number,
  tail: number,
): string {
  if (input.length <= head + tail + 1) return input;
  return `${input.slice(0, head)}…${tail > 0 ? input.slice(-tail) : ''}`;
}

function clampCommandForDisplay(
  input: string,
  head: number,
  tail: number,
): string {
  const budget = head + tail;
  if (input.length <= budget + 1) return input;
  const lines = input.split(/\r?\n/);
  if (lines.length <= 1 || lines[0].length > budget) {
    return headTailTruncate(input, head, tail);
  }
  const shown: string[] = [];
  let used = 0;
  for (const line of lines) {
    const nextUsed = used + (shown.length > 0 ? 1 : 0) + line.length;
    if (shown.length > 0 && nextUsed > budget) break;
    shown.push(line);
    used = nextUsed;
    if (used >= budget) break;
  }
  const hidden = lines.length - shown.length;
  if (hidden <= 0) return input;
  return `${shown.join('\n')}\n… (+${hidden} more lines)`;
}
