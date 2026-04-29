import { logger } from '../infrastructure/logging/logger.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import { AppMemoryService } from '../memory/app-memory-service.js';
import {
  resolveRuntimeAndGroup,
  resolveSessionId,
  resolveTranscriptPath,
  resolveUserId,
  type HookPayload,
} from './memory-hook-context.js';

type ExtractTrigger = 'precompact' | 'session-end';

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

type MemoryHookService = {
  isEnabled(): boolean;
  recordEvidence(input: {
    appId: string;
    agentId: string;
    groupId: string;
    userId?: string;
    sourceType: 'session';
    sourceId?: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
};

async function getMemoryService(): Promise<MemoryHookService> {
  return AppMemoryService.getInstance();
}

async function readTranscriptEvidence(input: {
  transcriptPath: string;
  sessionId?: string;
  trigger: ExtractTrigger;
  groupFolder: string;
  userId?: string;
}): Promise<{
  sourceId: string | undefined;
  text: string;
  metadata: Record<string, unknown>;
} | null> {
  let text = '';
  try {
    text = await import('node:fs/promises').then((fs) =>
      fs.readFile(input.transcriptPath, 'utf-8'),
    );
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    sourceId: input.sessionId,
    text: trimmed.slice(-24_000),
    metadata: {
      trigger: input.trigger,
      transcriptPath: input.transcriptPath,
      groupFolder: input.groupFolder,
      userId: input.userId,
    },
  };
}

export async function runMemoryHookCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  readPayload: () => Promise<HookPayload> = readStdinPayload,
  loadMemoryService: () => Promise<MemoryHookService> = getMemoryService,
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
    const { runtimeHome, groupFolder } = await resolveRuntimeAndGroup(
      payload,
      env,
    );

    if (runtimeHome) {
      env.MYCLAW_HOME = runtimeHome;
      process.env.MYCLAW_HOME = runtimeHome;
    }

    if (subcommand === 'load') {
      // Query-scoped runtime injection owns memory recall. SessionStart hooks do
      // not have the current user prompt, so they must not broad-load memory.
      writeSessionStartHookOutput('');
      return 0;
    }

    const trigger = parseTrigger(rest);
    if (!trigger || !groupFolder) {
      return 0;
    }

    const sessionId = resolveSessionId(payload, env);
    const transcriptPath = resolveTranscriptPath(
      payload,
      env.CLAUDE_CONFIG_DIR,
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
      if (!service.isEnabled()) return 0;
      const evidence = await readTranscriptEvidence({
        transcriptPath,
        sessionId,
        trigger,
        groupFolder,
        userId: resolveUserId(payload, env),
      });
      if (evidence) {
        await service.recordEvidence({
          appId: DEFAULT_MEMORY_APP_ID,
          agentId: memoryAgentIdForGroupFolder(groupFolder),
          groupId: groupFolder,
          userId: resolveUserId(payload, env),
          sourceType: 'session',
          sourceId: evidence.sourceId,
          text: evidence.text,
          metadata: evidence.metadata,
        });
      }
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
