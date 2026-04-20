import fs from 'fs';
import path from 'path';

import { logger } from '../core/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';

type ExtractTrigger = 'precompact' | 'session-end';

type HookPayload = {
  session_id?: string;
  sessionId?: string;
  user_id?: string;
  userId?: string;
  transcript_path?: string;
  transcriptPath?: string;
  cwd?: string;
  hook_event_name?: string;
  hookEventName?: string;
};

function isSafeSessionId(sessionId: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId)) return false;
  if (sessionId.includes('..')) return false;
  return true;
}

function normalizePath(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

function isWithin(rootDir: string, candidatePath: string): boolean {
  const rel = path.relative(rootDir, candidatePath);
  return !(rel.startsWith('..') || path.isAbsolute(rel));
}

function resolveRuntimeAndGroupFromProjectDir(projectDirRaw?: string): {
  runtimeHome?: string;
  groupFolder?: string;
} {
  const projectDir = normalizePath(projectDirRaw);
  if (!projectDir) return {};

  const marker = `${path.sep}data${path.sep}sessions${path.sep}`;
  const markerIndex = projectDir.lastIndexOf(marker);
  if (markerIndex === -1) return {};

  const runtimeHome = projectDir.slice(0, markerIndex) || undefined;
  const remainder = projectDir.slice(markerIndex + marker.length);
  const [groupFolder] = remainder.split(path.sep).filter(Boolean);

  return {
    runtimeHome,
    groupFolder:
      groupFolder && isValidGroupFolder(groupFolder) ? groupFolder : undefined,
  };
}

async function readStdinPayload(): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as HookPayload;
  } catch {
    logger.warn('Ignoring malformed hook stdin payload for memory-hook');
    return {};
  }
}

function parseTrigger(argv: string[]): ExtractTrigger | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const raw =
      arg === '--trigger'
        ? argv[index + 1]
        : arg.startsWith('--trigger=')
          ? arg.slice('--trigger='.length)
          : undefined;
    if (!raw) continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'precompact') return 'precompact';
    if (normalized === 'session-end') return 'session-end';
    return undefined;
  }
  return undefined;
}

function resolveRuntimeAndGroup(
  payload: HookPayload,
  env: NodeJS.ProcessEnv,
): {
  runtimeHome?: string;
  groupFolder?: string;
  projectDir?: string;
} {
  const explicitGroup = env.MYCLAW_GROUP_FOLDER?.trim();
  const projectDir = normalizePath(env.CLAUDE_PROJECT_DIR);
  const fromProject = resolveRuntimeAndGroupFromProjectDir(projectDir);
  const runtimeHome =
    env.AGENT_ROOT?.trim() || fromProject.runtimeHome || undefined;

  let groupFolder: string | undefined;
  if (explicitGroup && isValidGroupFolder(explicitGroup)) {
    groupFolder = explicitGroup;
  } else if (fromProject.groupFolder) {
    groupFolder = fromProject.groupFolder;
  }

  if (!groupFolder && runtimeHome && projectDir) {
    try {
      const db = openRuntimeGroupDb(runtimeHome);
      const groups = Object.values(db.getAllRegisteredGroups());
      db.close();
      const matched = groups.find((group) => {
        const groupProjectRoot = path.resolve(
          runtimeHome,
          'data',
          'sessions',
          group.folder,
        );
        return isWithin(groupProjectRoot, projectDir);
      });
      if (matched?.folder && isValidGroupFolder(matched.folder)) {
        groupFolder = matched.folder;
      }
    } catch (err) {
      logger.debug({ err }, 'Failed runtime group DB lookup for memory-hook');
    }
  }

  return {
    runtimeHome,
    groupFolder,
    projectDir,
  };
}

function resolveSessionId(
  payload: HookPayload,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw =
    payload.session_id ||
    payload.sessionId ||
    env.CLAUDE_SESSION_ID ||
    undefined;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

function resolveUserId(
  payload: HookPayload,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw =
    payload.user_id ||
    payload.userId ||
    env.MYCLAW_USER_ID ||
    env.CLAUDE_USER_ID ||
    undefined;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

function resolveTranscriptPath(
  payload: HookPayload,
  runtimeHome: string | undefined,
  groupFolder: string,
  sessionId: string | undefined,
): string | undefined {
  if (!runtimeHome || !sessionId || !isSafeSessionId(sessionId)) {
    return undefined;
  }

  const projectsRoot = path.resolve(
    runtimeHome,
    'data',
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );
  const validateCandidate = (candidatePath: string): string | undefined => {
    if (!fs.existsSync(candidatePath)) return undefined;
    const baseName = path.basename(candidatePath);
    if (!baseName.endsWith('.jsonl')) return undefined;
    if (baseName !== `${sessionId}.jsonl`) return undefined;

    let resolvedTranscript: string;
    let resolvedRoot: string;
    try {
      resolvedTranscript = fs.realpathSync(candidatePath);
      resolvedRoot = fs.realpathSync(projectsRoot);
    } catch {
      return undefined;
    }
    return isWithin(resolvedRoot, resolvedTranscript)
      ? resolvedTranscript
      : undefined;
  };

  const raw = payload.transcript_path || payload.transcriptPath;
  const provided = normalizePath(raw);
  if (provided) {
    const validated = validateCandidate(provided);
    if (validated) return validated;
  }

  if (!fs.existsSync(projectsRoot)) {
    return undefined;
  }
  const expectedPath = path.join(
    projectsRoot,
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
  const expectedValidated = validateCandidate(expectedPath);
  if (expectedValidated) return expectedValidated;

  const stack = [projectsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== `${sessionId}.jsonl`) continue;
      const validated = validateCandidate(fullPath);
      if (validated) return validated;
    }
  }

  return undefined;
}

function writeSessionStartHookOutput(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }),
  );
}

function usage(): string {
  return [
    'Usage:',
    '  myclaw memory-hook load',
    '  myclaw memory-hook extract --trigger=<precompact|session-end>',
  ].join('\n');
}

type MemoryServiceInstance = {
  ingestGroupSources(groupFolder: string): Promise<void>;
  ingestGlobalKnowledge(dirOverride?: string): Promise<void>;
  buildBrief(input: {
    groupFolder: string;
    maxItems: number;
    userId?: string;
  }): Promise<string>;
  extractFromTranscript(input: {
    transcriptPath: string;
    sessionId?: string;
    trigger: ExtractTrigger;
    groupFolder: string;
    userId?: string;
  }): Promise<void>;
};

async function getMemoryService(): Promise<MemoryServiceInstance> {
  const module = await import('../memory/memory-service.js');
  return module.MemoryService.getInstance();
}

export async function runMemoryHookCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  readPayload: () => Promise<HookPayload> = readStdinPayload,
  loadMemoryService: () => Promise<MemoryServiceInstance> = getMemoryService,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'load' && subcommand !== 'extract') {
    logger.warn({ argv }, usage());
    return 0;
  }

  const previousLogStderr = process.env.MYCLAW_LOG_STDERR;
  process.env.MYCLAW_LOG_STDERR = '1';
  env.MYCLAW_LOG_STDERR = '1';

  try {
    const payload = await readPayload();
    const { runtimeHome, groupFolder } = resolveRuntimeAndGroup(payload, env);

    if (runtimeHome) {
      env.AGENT_ROOT = runtimeHome;
      process.env.AGENT_ROOT = runtimeHome;
    }

    if (subcommand === 'load') {
      if (!groupFolder) {
        writeSessionStartHookOutput('');
        return 0;
      }

      try {
        const service = await loadMemoryService();
        await service.ingestGroupSources(groupFolder);
        await service.ingestGlobalKnowledge();
        const brief = await service.buildBrief({
          groupFolder,
          maxItems: 20,
          userId: resolveUserId(payload, env),
        });
        writeSessionStartHookOutput(brief);
      } catch (err) {
        logger.warn({ err, groupFolder }, 'memory-hook load failed');
        writeSessionStartHookOutput('');
      }

      return 0;
    }

    const trigger = parseTrigger(rest);
    if (!trigger || !groupFolder) {
      return 0;
    }

    const sessionId = resolveSessionId(payload, env);
    const transcriptPath = resolveTranscriptPath(
      payload,
      runtimeHome,
      groupFolder,
      sessionId,
    );
    if (!transcriptPath) {
      logger.warn(
        { trigger, groupFolder, sessionId: sessionId || null },
        'memory-hook extract skipped: transcript not found',
      );
      return 0;
    }

    try {
      const service = await loadMemoryService();
      await service.extractFromTranscript({
        transcriptPath,
        sessionId,
        trigger,
        groupFolder,
        userId: resolveUserId(payload, env),
      });
    } catch (err) {
      logger.warn({ err, trigger, groupFolder }, 'memory-hook extract failed');
    }

    return 0;
  } finally {
    if (previousLogStderr === undefined) {
      delete process.env.MYCLAW_LOG_STDERR;
    } else {
      process.env.MYCLAW_LOG_STDERR = previousLogStderr;
    }
    if (previousLogStderr === undefined) {
      delete env.MYCLAW_LOG_STDERR;
    } else {
      env.MYCLAW_LOG_STDERR = previousLogStderr;
    }
  }
}
