import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

interface SessionHookSpec {
  event: 'SessionStart' | 'PreCompact' | 'SessionEnd';
  command: 'load' | 'extract-precompact' | 'extract-session-end';
  matcher?: string;
  timeout: number;
  async?: boolean;
}

interface HookMatcherEntry {
  matcher: string;
  hooks: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface SessionHookChange {
  event: SessionHookSpec['event'];
  command: string;
}

export interface SessionHookInstallPlan {
  settingsPath: string;
  beforeText: string;
  afterText: string;
  changed: boolean;
  added: SessionHookChange[];
}

export interface SessionHookValidationResult {
  ok: boolean;
  settingsPath: string;
  missing: SessionHookChange[];
  error?: string;
}

const SESSION_HOOK_SPECS: SessionHookSpec[] = [
  {
    event: 'SessionStart',
    command: 'load',
    matcher: 'startup|resume|compact',
    timeout: 10,
  },
  {
    event: 'PreCompact',
    command: 'extract-precompact',
    timeout: 120,
    async: true,
  },
  {
    event: 'SessionEnd',
    command: 'extract-session-end',
    matcher: 'clear|resume|logout|other',
    timeout: 120,
    async: true,
  },
];

function resolveSessionHookCliPath(): string {
  const runtimeResolved = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'index.js',
  );
  if (fs.existsSync(runtimeResolved)) {
    return runtimeResolved;
  }
  return path.resolve(process.cwd(), 'dist', 'cli', 'index.js');
}

function buildHookCommand(
  command: SessionHookSpec['command'],
  cliPath = resolveSessionHookCliPath(),
): string {
  if (command === 'load') {
    return `node ${JSON.stringify(cliPath)} memory-hook load`;
  }
  if (command === 'extract-precompact') {
    return `node ${JSON.stringify(cliPath)} memory-hook extract --trigger=precompact`;
  }
  return `node ${JSON.stringify(cliPath)} memory-hook extract --trigger=session-end`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeEventEntries(value: unknown): HookMatcherEntry[] {
  if (!Array.isArray(value)) return [];

  const normalized: HookMatcherEntry[] = [];
  for (const entry of value) {
    const obj = asObject(entry);
    const matcher =
      typeof obj.matcher === 'string' && obj.matcher.trim()
        ? obj.matcher.trim()
        : '*';
    const hooksRaw = Array.isArray(obj.hooks) ? obj.hooks : [];
    const hooks = hooksRaw
      .map((hook) => asObject(hook))
      .filter((hook) => Object.keys(hook).length > 0);
    normalized.push({ ...obj, matcher, hooks });
  }

  return normalized;
}

function hasHookSpec(
  entries: HookMatcherEntry[],
  spec: SessionHookSpec,
  expectedCommand: string,
): boolean {
  const targetMatcher = spec.matcher || '*';
  for (const entry of entries) {
    if (entry.matcher !== targetMatcher) continue;
    for (const hook of entry.hooks) {
      const timeoutMatches =
        typeof hook.timeout === 'number' && hook.timeout === spec.timeout;
      const asyncMatches =
        spec.async === undefined
          ? hook.async === undefined
          : hook.async === spec.async;
      if (
        hook.type === 'command' &&
        hook.command === expectedCommand &&
        timeoutMatches &&
        asyncMatches
      ) {
        return true;
      }
    }
  }
  return false;
}

function findMatcherEntry(
  entries: HookMatcherEntry[],
  matcher: string,
): HookMatcherEntry | null {
  for (const entry of entries) {
    if (entry.matcher === matcher) return entry;
  }
  return null;
}

export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function buildSessionHookInstallPlan(
  settingsPath = defaultClaudeSettingsPath(),
  cliPath = resolveSessionHookCliPath(),
): SessionHookInstallPlan {
  let beforeText = '';
  if (fs.existsSync(settingsPath)) {
    beforeText = fs.readFileSync(settingsPath, 'utf-8');
  }

  const parsedRoot = (() => {
    if (!beforeText.trim()) return {};
    const parsed = JSON.parse(beforeText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object at root.');
    }
    return parsed as Record<string, unknown>;
  })();

  const mergedRoot = { ...parsedRoot };
  const hooksRoot = asObject(mergedRoot.hooks);
  const added: SessionHookChange[] = [];

  for (const spec of SESSION_HOOK_SPECS) {
    const expectedCommand = buildHookCommand(spec.command, cliPath);
    const entries = normalizeEventEntries(hooksRoot[spec.event]);
    if (hasHookSpec(entries, spec, expectedCommand)) {
      hooksRoot[spec.event] = entries;
      continue;
    }

    const targetMatcher = spec.matcher || '*';
    const targetEntry =
      findMatcherEntry(entries, targetMatcher) ||
      ({ matcher: targetMatcher, hooks: [] } as HookMatcherEntry);
    if (!entries.includes(targetEntry)) {
      entries.push(targetEntry);
    }

    const hookDefinition: Record<string, unknown> = {
      type: 'command',
      command: expectedCommand,
      timeout: spec.timeout,
    };
    if (spec.async !== undefined) {
      hookDefinition.async = spec.async;
    }

    targetEntry.hooks.push(hookDefinition);
    hooksRoot[spec.event] = entries;
    added.push({
      event: spec.event,
      command: expectedCommand,
    });
  }

  mergedRoot.hooks = hooksRoot;
  const afterText = `${JSON.stringify(mergedRoot, null, 2)}\n`;

  return {
    settingsPath,
    beforeText,
    afterText,
    changed: added.length > 0,
    added,
  };
}

export function formatSessionHookInstallDiff(
  plan: SessionHookInstallPlan,
): string {
  if (!plan.changed) {
    return `No hook changes needed in ${plan.settingsPath}.`;
  }

  const lines: string[] = [
    `Planned changes for ${plan.settingsPath}:`,
    ...plan.added.map((change) => `+ ${change.event}: ${change.command}`),
  ];
  return lines.join('\n');
}

export function applySessionHookInstallPlan(
  plan: SessionHookInstallPlan,
): void {
  if (!plan.changed) return;
  fs.mkdirSync(path.dirname(plan.settingsPath), { recursive: true });
  fs.writeFileSync(plan.settingsPath, plan.afterText, 'utf-8');
}

export function validateSessionHooksInstalled(
  settingsPath = defaultClaudeSettingsPath(),
  cliPath = resolveSessionHookCliPath(),
): SessionHookValidationResult {
  try {
    const plan = buildSessionHookInstallPlan(settingsPath, cliPath);
    return {
      ok: !plan.changed,
      settingsPath: plan.settingsPath,
      missing: plan.added,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      settingsPath,
      missing: [],
      error: message,
    };
  }
}
