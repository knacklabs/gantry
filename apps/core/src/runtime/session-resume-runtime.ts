import { ASSISTANT_NAME } from '../config/index.js';
import type { NewMessage, RegisteredGroup } from '../domain/types.js';
import type { OpsRepository } from '../domain/repositories/ops-repo.js';
import { logger } from '../infrastructure/logging/logger.js';
import { archiveSessionTranscript } from '../session/session-transcript-archive.js';
import type { GroupProcessingDeps } from './group-processing-types.js';

export async function expireStaleRuntimeSession(input: {
  group: RegisteredGroup;
  deps: GroupProcessingDeps;
  ops: OpsRepository;
  sessionId: string;
  providerSessionId?: string;
  agentSessionId?: string;
  threadId: string | null;
  error?: string;
}): Promise<void> {
  logger.warn(
    {
      group: input.group.name,
      staleSessionId: input.sessionId,
      error: input.error,
    },
    'Stale provider session detected; expiring provider resume metadata',
  );
  archiveSessionTranscript({
    groupFolder: input.group.folder,
    sessionId: input.sessionId,
    assistantName: ASSISTANT_NAME,
    cause: 'stale-session',
    errorSummary: input.error,
    writePlaceholderOnMissing: true,
  });
  await input.ops.expireProviderSession?.({
    providerSessionId: input.providerSessionId,
    agentSessionId: input.agentSessionId,
    externalSessionId: input.sessionId,
  });
  await input.deps.clearCachedSession?.(input.group.folder, input.threadId);
}

export function isStaleRuntimeSessionError(input: {
  sessionId?: string | null;
  error?: string;
}): boolean {
  return Boolean(
    input.sessionId &&
    input.error &&
    /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
      input.error,
    ),
  );
}

export async function persistRuntimeProviderSession(input: {
  deps: GroupProcessingDeps;
  group: RegisteredGroup;
  sessionId: string;
  threadId: string | null;
  chatJid: string;
  artifactRef?: string | null;
}): Promise<void> {
  if (input.artifactRef) {
    await input.deps.setSession(
      input.group.folder,
      input.sessionId,
      input.threadId,
      {
        chatJid: input.chatJid,
        artifactRef: input.artifactRef,
      },
    );
    return;
  }
  await input.deps.setSession(
    input.group.folder,
    input.sessionId,
    input.threadId,
  );
}

export async function completeSuccessfulRuntimeSessionRun(input: {
  deps: GroupProcessingDeps;
  ops: OpsRepository;
  group: RegisteredGroup;
  sessionId?: string | null;
  pendingSessionId?: string | null;
  artifactRef?: string | null;
  pendingArtifactRef?: string | null;
  threadId: string | null;
  chatJid: string;
  agentSessionId?: string;
  runId?: string;
  result?: string | null;
}): Promise<void> {
  const nextSessionId = input.sessionId || input.pendingSessionId;
  const artifactRef = input.artifactRef || input.pendingArtifactRef;
  if (nextSessionId) {
    await persistRuntimeProviderSession({
      deps: input.deps,
      group: input.group,
      sessionId: nextSessionId,
      threadId: input.threadId,
      chatJid: input.chatJid,
      artifactRef,
    });
  }
  if (input.runId) {
    await input.ops.completeSessionAgentRun?.({
      runId: input.runId,
      status: 'completed',
      resultSummary: input.result ?? null,
    });
  }
  if (input.agentSessionId) {
    void input.ops
      .checkpointSessionSummary?.(input.agentSessionId)
      .catch((err: unknown) => {
        logger.warn(
          { group: input.group.name, err },
          'Failed to checkpoint session summary',
        );
      });
  }
}

export async function completeFailedRuntimeSessionRun(input: {
  ops: OpsRepository;
  runId?: string;
  errorSummary: string;
}): Promise<void> {
  if (!input.runId) return;
  await input.ops.completeSessionAgentRun?.({
    runId: input.runId,
    status: 'failed',
    errorSummary: input.errorSummary,
  });
}

export function joinRuntimeContextBlocks(
  ...blocks: Array<string | null | undefined>
): string | undefined {
  return blocks.filter(Boolean).join('\n\n') || undefined;
}

export function resolveMemoryUserId(
  messages: NewMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.is_from_me) continue;
    const sender = message.sender?.trim();
    if (sender) return sender;
  }
  return messages[messages.length - 1]?.sender?.trim() || undefined;
}
