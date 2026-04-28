import { ASSISTANT_NAME } from '../config/index.js';
import type { NewMessage, RegisteredGroup } from '../domain/types.js';
import type { OpsRepository } from '../domain/repositories/ops-repo.js';
import type { ProviderArtifactStore } from '../domain/ports/provider-artifact-store.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  archiveProviderSessionTranscript,
  type SessionArchiveCause,
} from '../session/session-transcript-archive.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import type { RunAgentOptions } from './agent-spawn-types.js';

export async function expireStaleRuntimeSession(input: {
  group: RegisteredGroup;
  deps: GroupProcessingDeps;
  ops: OpsRepository;
  sessionId: string;
  providerSessionId?: string;
  provider?: string;
  agentSessionId?: string;
  appId?: string;
  agentId?: string;
  providerArtifactStore?: ProviderArtifactStore;
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
  if (!input.providerArtifactStore) {
    logger.warn(
      { group: input.group.name, sessionId: input.sessionId },
      'Skipped stale session archive because ProviderArtifactStore is unavailable',
    );
  } else if (
    input.providerSessionId &&
    input.agentSessionId &&
    input.appId &&
    input.agentId
  ) {
    await archiveProviderSessionTranscript({
      providerArtifactStore: input.providerArtifactStore,
      appId: input.appId,
      agentId: input.agentId,
      agentSessionId: input.agentSessionId,
      providerSessionId: input.providerSessionId,
      provider: input.provider,
      sessionId: input.sessionId,
      assistantName: ASSISTANT_NAME,
      cause: 'stale-session',
      errorSummary: input.error,
      writePlaceholderOnMissing: true,
    });
  }
  await input.ops.expireProviderSession?.({
    providerSessionId: input.providerSessionId,
    agentSessionId: input.agentSessionId,
    externalSessionId: input.sessionId,
  });
}

export async function archiveCurrentRuntimeSession(input: {
  deps: GroupProcessingDeps;
  ops: OpsRepository;
  group: RegisteredGroup;
  chatJid: string;
  threadId: string | null;
  cause?: SessionArchiveCause;
}): Promise<void> {
  const providerArtifactStore = input.deps.getProviderArtifactStore?.();
  const resume = await input.ops.getSessionResume?.({
    groupFolder: input.group.folder,
    chatJid: input.chatJid,
    threadId: input.threadId,
  });
  if (
    providerArtifactStore &&
    resume?.providerSessionId &&
    resume.externalSessionId
  ) {
    await archiveProviderSessionTranscript({
      providerArtifactStore,
      appId: resume.appId,
      agentId: resume.agentId,
      agentSessionId: resume.agentSessionId,
      providerSessionId: resume.providerSessionId,
      provider: resume.provider,
      sessionId: resume.externalSessionId,
      assistantName: ASSISTANT_NAME,
      cause: input.cause ?? 'new-session',
    });
    return;
  }
  logger.info(
    { group: input.group.name, providerSessionId: resume?.providerSessionId },
    'Skipped session archive because no provider artifact is available',
  );
}

export function buildProviderArtifactRunOptions(input: {
  timeoutMs?: number;
  credentialBroker?: RunAgentOptions['credentialBroker'];
  providerArtifactStore?: ProviderArtifactStore;
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  skillContext?: {
    appId: string;
    agentId: string;
  };
  sessionResume?: {
    appId: string;
    agentId: string;
    agentSessionId: string;
    mode?: 'provider_native' | 'db_replay';
    providerSessionId?: string;
    provider?: string;
    latestArtifactId?: string;
  };
}): RunAgentOptions | undefined {
  if (
    input.sessionResume?.mode === 'provider_native' &&
    !input.providerArtifactStore
  ) {
    throw new Error(
      'ProviderArtifactStore is required for provider-native resume',
    );
  }
  const artifactOptions =
    input.providerArtifactStore && input.sessionResume
      ? {
          providerArtifactStore: input.providerArtifactStore,
          providerArtifactContext: {
            appId: input.sessionResume.appId,
            agentId: input.sessionResume.agentId,
            agentSessionId: input.sessionResume.agentSessionId,
            provider: input.sessionResume.provider,
            providerSessionId:
              input.sessionResume.mode === 'provider_native'
                ? input.sessionResume.providerSessionId
                : undefined,
            latestArtifactId:
              input.sessionResume.mode === 'provider_native'
                ? input.sessionResume.latestArtifactId
                : undefined,
          },
        }
      : {};
  const resolvedSkillContext = input.skillContext
    ? input.skillContext
    : input.sessionResume
      ? {
          appId: input.sessionResume.appId,
          agentId: input.sessionResume.agentId,
        }
      : undefined;
  const skillOptions =
    input.skillRepository && input.skillArtifactStore && resolvedSkillContext
      ? {
          skillRepository: input.skillRepository,
          skillArtifactStore: input.skillArtifactStore,
          skillContext: resolvedSkillContext,
        }
      : {};
  const options: RunAgentOptions = {
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.credentialBroker
      ? { credentialBroker: input.credentialBroker }
      : {}),
    ...artifactOptions,
    ...skillOptions,
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

export function isStaleRuntimeSessionError(input: {
  sessionId?: string | null;
  error?: string;
}): boolean {
  return Boolean(
    input.sessionId &&
    input.error &&
    /no conversation found|ENOENT.*\.jsonl|session.*not found|claude runtime materialization failed/i.test(
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
  latestArtifactId?: string | null;
}): Promise<void> {
  if (input.latestArtifactId) {
    await input.deps.setSession(
      input.group.folder,
      input.sessionId,
      input.threadId,
      {
        chatJid: input.chatJid,
        latestArtifactId: input.latestArtifactId,
      },
    );
    return;
  }
  await input.deps.setSession(
    input.group.folder,
    input.sessionId,
    input.threadId,
    { chatJid: input.chatJid },
  );
}

export async function completeSuccessfulRuntimeSessionRun(input: {
  deps: GroupProcessingDeps;
  ops: OpsRepository;
  group: RegisteredGroup;
  sessionId?: string | null;
  pendingSessionId?: string | null;
  latestArtifactId?: string | null;
  pendingLatestArtifactId?: string | null;
  threadId: string | null;
  chatJid: string;
  agentSessionId?: string;
  runId?: string;
  result?: string | null;
}): Promise<void> {
  const nextSessionId = input.sessionId || input.pendingSessionId;
  const latestArtifactId =
    input.latestArtifactId || input.pendingLatestArtifactId;
  if (nextSessionId) {
    await persistRuntimeProviderSession({
      deps: input.deps,
      group: input.group,
      sessionId: nextSessionId,
      threadId: input.threadId,
      chatJid: input.chatJid,
      latestArtifactId,
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
