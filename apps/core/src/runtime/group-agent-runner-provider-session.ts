import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import { providerSessionContinuityForExecutionProvider } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { ConversationRoute } from '../domain/types.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { ProviderSessionContinuity } from '../domain/repositories/ops-repo.js';
import type { RetiredProviderSessionReference } from '../domain/sessions/provider-session-measurement.js';
import type { AgentOutput } from './agent-spawn.js';
import type { GroupProcessingRepository } from './group-processing-types.js';
import {
  createRunProviderMetadataUpdater,
  persistDurableProviderSessionFromOutput,
} from './group-agent-runner-context-ceiling.js';

type AgentTurnContext = Awaited<
  ReturnType<NonNullable<GroupProcessingRepository['getAgentTurnContext']>>
>;

export function isStoppedProviderOutput({
  status,
  error,
}: AgentOutput): boolean {
  return status === 'error' && /\bstopped by request\b/i.test(error ?? '');
}

export type ProviderSessionRunOptions = {
  memoryContext?: {
    source: 'message' | 'command';
    userId?: string;
    label?: string;
    threadId?: string;
    recallQuery?: string;
  };
  existingRunId?: string;
  existingRunLeaseToken?: string;
  existingRunLeaseWorkerInstanceId?: string;
  existingRunLeaseFencingVersion?: number;
  maintenanceProviderSession?: {
    providerSessionId: string;
    externalSessionId: string;
  };
  readonly retiredProviderSessions?: RetiredProviderSessionReference[];
};

export function createProviderSessionContinuityResolver(input: {
  registry?: AgentExecutionAdapterRegistry;
  fallback?: AgentExecutionAdapter;
}): (executionProviderId: ExecutionProviderId) => ProviderSessionContinuity {
  return (executionProviderId) =>
    providerSessionContinuityForExecutionProvider({
      ...input,
      executionProviderId,
    });
}

export function initialProviderSessionIdentifiers(input: {
  continuity: ProviderSessionContinuity;
  maintenanceProviderSession?: ProviderSessionRunOptions['maintenanceProviderSession'];
  turnContext: AgentTurnContext | undefined;
}) {
  const maintenance =
    input.continuity === 'durable_resume'
      ? input.maintenanceProviderSession
      : undefined;
  const resumeProviderSessionId =
    maintenance?.providerSessionId ?? input.turnContext?.providerSessionId;
  return {
    latestProviderSessionId:
      maintenance?.externalSessionId.trim() ||
      input.turnContext?.externalSessionId?.trim(),
    currentProviderSessionId: resumeProviderSessionId,
    resumeProviderSessionId,
    resumeExternalSessionId:
      maintenance?.externalSessionId ?? input.turnContext?.externalSessionId,
    providerSessionPersistenceAllowed: input.continuity === 'durable_resume',
  };
}

function createGroupRunProviderMetadataUpdater(input: {
  repository(): GroupProcessingRepository;
  runId(): string | undefined;
  options?: ProviderSessionRunOptions;
  groupName: string;
}) {
  return createRunProviderMetadataUpdater({
    repository: input.repository,
    runId: input.runId,
    ...(input.options?.existingRunLeaseToken
      ? {
          lease: {
            leaseToken: input.options.existingRunLeaseToken,
            workerInstanceId: input.options.existingRunLeaseWorkerInstanceId,
            fencingVersion: input.options.existingRunLeaseFencingVersion,
          },
        }
      : {}),
    groupName: input.groupName,
  });
}

export function createGroupProviderSessionRuntime(input: {
  repository(): GroupProcessingRepository;
  runId(): string | undefined;
  state(): {
    persistenceAllowed: boolean;
    latestProviderSessionId: string | undefined;
    turnContext: AgentTurnContext | undefined;
    executionProviderId: ExecutionProviderId;
  };
  options?: ProviderSessionRunOptions;
  group: Pick<
    ConversationRoute,
    'name' | 'folder' | 'providerAccountId' | 'conversationKind'
  >;
  threadId: string | null;
  appId: string;
  conversationJid: string;
  accessFingerprint(): string;
  onPersisted(sessionId: string): void;
}) {
  const metadata = createGroupRunProviderMetadataUpdater({
    repository: input.repository,
    runId: input.runId,
    options: input.options,
    groupName: input.group.name,
  });
  return {
    ...metadata,
    persistOutput: async (output: AgentOutput) => {
      const state = input.state();
      const nextSessionId = await persistDurableProviderSessionFromOutput({
        output,
        persistenceAllowed: state.persistenceAllowed,
        latestProviderSessionId: state.latestProviderSessionId,
        turnContext: state.turnContext,
        maintenanceProviderSession: Boolean(
          input.options?.maintenanceProviderSession,
        ),
        repository: input.repository(),
        agentFolder: input.group.folder,
        threadId: input.threadId,
        appId: input.appId,
        executionProviderId: state.executionProviderId,
        conversationJid: input.conversationJid,
        providerAccountId: input.group.providerAccountId,
        conversationKind: input.group.conversationKind,
        memoryUserId: input.options?.memoryContext?.userId,
        accessFingerprint: input.accessFingerprint(),
        updateRunProviderMetadata: (providerSessionId) =>
          metadata.update({ providerSessionId }),
      });
      if (nextSessionId) input.onPersisted(nextSessionId);
    },
  };
}
