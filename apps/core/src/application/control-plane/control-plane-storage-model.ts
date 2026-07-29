import type { AppId } from '../../domain/app/app.js';
import type {
  ConversationRepository,
  ModelCredentialRepository,
} from '../../domain/ports/repositories.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import type { AgentHarness } from '../../shared/agent-engine.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import {
  DEFAULT_JOB_RUNTIME_APP_ID,
  filterJobsByCanonicalAppSession,
  type JobAppSessionLookupPort,
} from '../jobs/job-access.js';
import {
  requiredModelCredentialProviders,
  type RequiredModelCredentialProvidersSettings,
} from '../model-resolution/required-model-credential-providers.js';
import {
  buildControlPlaneReadModelFromSettings,
  type ControlPlaneReadModel,
  type ControlPlaneSettingsReadModelInput,
} from './control-plane-read-model.js';
import {
  controlPlaneJobStatus,
  controlPlaneMemoryStatus,
  controlPlaneProviderInputs,
  type ControlPlaneSettingsInputView,
} from './control-plane-settings-inputs.js';

export type ControlPlaneStorageSettings =
  ControlPlaneSettingsReadModelInput['settings'] &
    ControlPlaneSettingsInputView &
    RequiredModelCredentialProvidersSettings;

export type EffectiveControlRuntimeSettings = ControlPlaneStorageSettings &
  ControlObserverSettingsView & {
    memory: {
      enabled: boolean;
      dreaming: { enabled: boolean };
    };
    modelFamilies?: Record<string, string[]>;
  };

export type ControlAgentSettingsView = {
  agents: Record<
    string,
    { persona?: string; delegates: string[]; accessPreset?: string }
  >;
};

export interface ControlAgentSettingsPort {
  decodeRevisionDocument(
    document: Record<string, unknown>,
  ): ControlAgentSettingsView;
  defaultSettings(): ControlAgentSettingsView;
  serializeRevisionDocument(
    settings: ControlAgentSettingsView,
  ): Record<string, unknown>;
  writeAgentHarnessSetting(input: {
    runtimeHome: string;
    appId: AppId;
    folder: string;
    name: string;
    agentHarness: AgentHarness;
  }): Promise<void>;
}

export interface ControlSettingsImportPort {
  serializeRevisionDocument(
    settings: ControlPlaneStorageSettings,
  ): Record<string, unknown>;
  importWorkstation(
    deps: Record<string, unknown>,
    settings: unknown,
  ): Promise<
    | { status: 'revision_created'; revision: number }
    | { status: 'applied_no_revision' }
    | { status: 'no_op' }
  >;
  importFleet(
    deps: Record<string, unknown>,
    settings: unknown,
    options: { expectedRevision?: number | null; note?: string | null },
  ): Promise<
    | { status: 'applied'; revision: number }
    | { status: 'invalid'; errors: string[] }
    | { status: 'conflict'; expectedRevision: number; actualRevision: number }
  >;
  classifyImportError(
    error: unknown,
  ):
    | { kind: 'stale' }
    | { kind: 'conflict'; expectedRevision: number; actualRevision: number }
    | null;
}

export interface ControlObserverStatus {
  enabled: boolean;
  activation:
    | 'disabled'
    | 'configuration_required'
    | 'evidence_accumulating'
    | 'active';
  message: string;
  dreamingEnabled: boolean;
  owner: {
    recipient: string;
    conversation: string;
    conversationJid: string;
    providerAccountId: string;
  } | null;
}

export type ResolveControlObserverStatus = (
  appId: AppId,
) => Promise<ControlObserverStatus>;

export interface ControlObserverSettingsView {
  observer: {
    enabled: boolean;
    owner?: { recipient: string; conversation: string };
  };
  providers: Record<string, { enabled: boolean }>;
  providerAccounts: Record<
    string,
    { provider: string; status?: 'active' | 'disabled' }
  >;
  conversations: Record<
    string,
    {
      providerConnection?: string;
      providerAccount: string;
      externalId: string;
      kind: string;
      controlApprovers: string[];
    }
  >;
}

export function createResolveObserverStatus(input: {
  getEffectiveRuntimeSettings: () => EffectiveControlRuntimeSettings;
  getInternalRuntimeSettings: () => EffectiveControlRuntimeSettings;
  getEffectiveMemoryState: () => {
    enabled: boolean;
    dreamingEnabled: boolean;
  };
  conversations: ConversationRepository;
}): ResolveControlObserverStatus {
  return (appId) =>
    resolveControlObserverStatus({
      appId,
      settings: {
        ...input.getEffectiveRuntimeSettings(),
        conversations: input.getInternalRuntimeSettings().conversations,
      } as unknown as ControlObserverSettingsView,
      memoryState: input.getEffectiveMemoryState(),
      conversations: input.conversations,
    });
}

export async function resolveControlObserverStatus(input: {
  appId: AppId;
  settings: ControlObserverSettingsView;
  memoryState: { enabled: boolean; dreamingEnabled: boolean };
  conversations: ConversationRepository;
}): Promise<ControlObserverStatus> {
  const { settings, memoryState } = input;
  if (!settings.observer.enabled) {
    return observerStatus(
      false,
      'disabled',
      'Observer is disabled.',
      memoryState,
    );
  }
  const owner = settings.observer.owner;
  const conversation = owner
    ? settings.conversations[owner.conversation]
    : undefined;
  const providerAccountId = conversation
    ? conversation.providerAccount || conversation.providerConnection || ''
    : '';
  const providerAccount = settings.providerAccounts[providerAccountId];
  if (
    !owner ||
    !conversation ||
    (conversation.kind !== 'dm' && conversation.kind !== 'direct') ||
    !conversation.controlApprovers.includes(owner.recipient) ||
    !providerAccount ||
    providerAccount.status === 'disabled' ||
    settings.providers[providerAccount.provider]?.enabled !== true
  ) {
    return observerStatus(
      true,
      'configuration_required',
      'Observer owner and owner DM must be configured.',
      memoryState,
    );
  }
  const stored = await input.conversations.getConversationByExternalRef({
    appId: input.appId,
    providerId: providerAccount.provider as ProviderId,
    providerAccountId: providerAccountId as ProviderAccountId,
    externalConversationId: conversation.externalId,
  });
  if (!stored || stored.kind !== 'direct') {
    return unverifiedObserverOwner(memoryState);
  }
  const [participants, approvers] = await Promise.all([
    input.conversations.listParticipantExternalUserIds(stored.id),
    input.conversations.listConversationApprovers(stored.id),
  ]);
  if (
    !participants.includes(owner.recipient) ||
    !approvers.some((approver) => approver.externalUserId === owner.recipient)
  ) {
    return unverifiedObserverOwner(memoryState);
  }
  const scopedConversationPrefix = `conversation:${providerAccountId}:`;
  const storedConversationId = String(stored.id);
  const conversationJid = storedConversationId.startsWith(
    scopedConversationPrefix,
  )
    ? storedConversationId.slice(scopedConversationPrefix.length)
    : storedConversationId.startsWith('conversation:')
      ? storedConversationId.slice('conversation:'.length)
      : conversation.externalId;
  const resolvedOwner = {
    ...owner,
    conversationJid,
    providerAccountId,
  };
  if (!memoryState.enabled) {
    return observerStatus(
      true,
      'evidence_accumulating',
      'Memory is off; evidence is accumulating, but observer promotion is disabled.',
      memoryState,
      resolvedOwner,
    );
  }
  if (!memoryState.dreamingEnabled) {
    return observerStatus(
      true,
      'evidence_accumulating',
      'Dreaming is off; evidence is accumulating, but promotion is disabled.',
      memoryState,
      resolvedOwner,
    );
  }
  return observerStatus(
    true,
    'active',
    'Observer is active.',
    memoryState,
    resolvedOwner,
  );
}

function observerStatus(
  enabled: boolean,
  activation: ControlObserverStatus['activation'],
  message: string,
  memoryState: { enabled: boolean; dreamingEnabled: boolean },
  owner: ControlObserverStatus['owner'] = null,
): ControlObserverStatus {
  return {
    enabled,
    activation,
    message,
    dreamingEnabled: memoryState.enabled && memoryState.dreamingEnabled,
    owner,
  };
}

function unverifiedObserverOwner(memoryState: {
  enabled: boolean;
  dreamingEnabled: boolean;
}): ControlObserverStatus {
  return observerStatus(
    true,
    'configuration_required',
    'Observer owner must be a verified member and persisted control approver of the owner DM.',
    memoryState,
  );
}

/**
 * Build the unified control-plane read model from runtime storage repositories.
 * Shared by the CLI (`gantry next`) and the MCP guided-action preview so both
 * derive the identical next action, including jobs, that the Control API already
 * derives via its injected request context.
 */
export async function buildControlPlaneReadModelFromRepositories(input: {
  appId: AppId;
  settings: ControlPlaneStorageSettings;
  jobsRepository: Pick<RuntimeJobRepository, 'listJobs'>;
  jobControlRepository?: JobAppSessionLookupPort;
  modelCredentialsRepository: Pick<
    ModelCredentialRepository,
    'listModelCredentials'
  >;
  pendingAccessRequestsRepository: {
    countPendingAccessRequests(input: { appId: AppId }): Promise<number>;
  };
}): Promise<ControlPlaneReadModel> {
  const { appId, settings } = input;
  const credentials =
    await input.modelCredentialsRepository.listModelCredentials({ appId });
  const jobs = await listControlPlaneJobs(input);
  const accessNeedsApprovalCount =
    await input.pendingAccessRequestsRepository.countPendingAccessRequests({
      appId,
    });
  const activeProviderIds = new Set<string>(
    credentials
      .filter((credential) => credential.status === 'active')
      .map((credential) => credential.providerId),
  );
  const requiredProviders = requiredModelCredentialProviders(settings);
  return buildControlPlaneReadModelFromSettings({
    settings,
    workspaceKey: appId,
    modelCredentialReady: requiredProviders.every((providerId) =>
      activeProviderIds.has(providerId),
    ),
    providers: controlPlaneProviderInputs(settings),
    accessNeedsApprovalCount,
    memoryStatus: controlPlaneMemoryStatus(settings.memory?.enabled === true),
    jobs: jobs.map((job) => ({
      id: job.id,
      ...(job.workspace_key ? { agentId: job.workspace_key } : {}),
      status: controlPlaneJobStatus(job.status),
    })),
  });
}

async function listControlPlaneJobs(input: {
  appId: AppId;
  jobsRepository: Pick<RuntimeJobRepository, 'listJobs'>;
  jobControlRepository?: JobAppSessionLookupPort;
}) {
  const defaultScope = input.appId === DEFAULT_JOB_RUNTIME_APP_ID;
  const jobs = await input.jobsRepository.listJobs({
    ...(defaultScope ? {} : { appId: input.appId }),
  });
  return input.jobControlRepository
    ? filterJobsByCanonicalAppSession({
        control: input.jobControlRepository,
        jobs,
        appId: input.appId,
      })
    : jobs;
}
