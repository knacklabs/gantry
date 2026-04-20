#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';

import type { SessionArchiveCause } from '../memory/memory-root.js';
import { isValidGroupFolder } from '../platform/group-folder.js';

type HookCause = 'session-start' | 'pre-compact' | 'session-stop';

type ArchiveSessionInput = {
  groupFolder: string;
  sessionId: string;
  cause: SessionArchiveCause;
  writePlaceholderOnMissing: false;
};

interface SessionHookArchiveModule {
  archiveSessionTranscript: (input: ArchiveSessionInput) => unknown;
}

export interface RunSessionHookOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  loadArchiveModule?: () => Promise<SessionHookArchiveModule>;
}

export function parseCauseArg(argv: string[]): HookCause | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cause') {
      return normalizeHookCause(argv[index + 1]);
    }
    if (arg.startsWith('--cause=')) {
      return normalizeHookCause(arg.slice('--cause='.length));
    }
  }
  return undefined;
}

export function normalizeHookCause(raw?: string): HookCause | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === 'session-start') return 'session-start';
  if (value === 'pre-compact') return 'pre-compact';
  if (value === 'session-stop') return 'session-stop';
  return undefined;
}

export function mapHookEventToCause(raw?: string): HookCause | undefined {
  const normalized = raw
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (normalized === 'sessionstart' || normalized === 'session-start') {
    return 'session-start';
  }
  if (normalized === 'precompact' || normalized === 'pre-compact') {
    return 'pre-compact';
  }
  if (normalized === 'stop' || normalized === 'session-stop') {
    return 'session-stop';
  }
  return undefined;
}

export function mapHookCauseToArchiveCause(
  cause: HookCause,
): SessionArchiveCause {
  if (cause === 'session-start') return 'new-session';
  if (cause === 'pre-compact') return 'manual-compact';
  return 'abandoned-session';
}

export function isSafeSessionId(value?: string): boolean {
  if (!value) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) return false;
  if (value.includes('..')) return false;
  return true;
}

export function resolveRuntimeFromProjectDir(projectDir?: string): {
  runtimeHome?: string;
  groupFolder?: string;
} {
  const raw = projectDir?.trim();
  if (!raw) return {};

  const resolved = path.resolve(raw);
  const marker = `${path.sep}data${path.sep}sessions${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex === -1) return {};

  const runtimeHome = resolved.slice(0, markerIndex);
  const remainder = resolved.slice(markerIndex + marker.length);
  const [groupFolder] = remainder.split(path.sep).filter(Boolean);

  return {
    runtimeHome: runtimeHome || undefined,
    groupFolder: groupFolder || undefined,
  };
}

async function defaultLoadArchiveModule(): Promise<SessionHookArchiveModule> {
  return import('../session/session-transcript-archive.js');
}

export async function runSessionHook(
  options: RunSessionHookOptions = {},
): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const explicitCause = parseCauseArg(argv);
  const cause = explicitCause || mapHookEventToCause(env.CLAUDE_HOOK_EVENT);
  const rawSessionId = env.CLAUDE_SESSION_ID?.trim();
  const fromProject = resolveRuntimeFromProjectDir(env.CLAUDE_PROJECT_DIR);
  const rawGroupFolder =
    env.MYCLAW_GROUP_FOLDER?.trim() || fromProject.groupFolder;
  const groupFolder =
    rawGroupFolder && isValidGroupFolder(rawGroupFolder)
      ? rawGroupFolder
      : undefined;
  const sessionId =
    rawSessionId && isSafeSessionId(rawSessionId) ? rawSessionId : undefined;

  if (!env.AGENT_ROOT && fromProject.runtimeHome) {
    env.AGENT_ROOT = fromProject.runtimeHome;
  }

  if (!cause || !sessionId || !groupFolder) {
    return;
  }

  try {
    const archiveModule = options.loadArchiveModule || defaultLoadArchiveModule;
    const { archiveSessionTranscript } = await archiveModule();
    archiveSessionTranscript({
      groupFolder,
      sessionId,
      cause: mapHookCauseToArchiveCause(cause),
      writePlaceholderOnMissing: false,
    });
  } catch {
    // Hooks must never block Claude Code session lifecycle.
  }
}

function isDirectExecution(argv: string[] = process.argv): boolean {
  const scriptPath = argv[1];
  if (!scriptPath) return false;
  return path.resolve(scriptPath) === fileURLToPath(import.meta.url);
}

export async function main(): Promise<void> {
  try {
    await runSessionHook();
  } catch {
    // Hooks must never block Claude Code session lifecycle.
  }
  process.exit(0);
}

if (isDirectExecution()) {
  void main();
}
