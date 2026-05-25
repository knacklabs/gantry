import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentConversationBinding,
  AgentConversationBindingMemoryScope,
  AgentConversationBindingTriggerMode,
  Provider,
  ProviderConnection,
  ProviderConnectionId,
  ProviderId,
} from '../../domain/provider/provider.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../domain/memory/memory.js';
import type {
  AgentRepository,
  ProviderConnectionRepository,
  ConversationRepository,
} from '../../domain/ports/repositories.js';
import type { PermissionPolicyId } from '../../domain/permissions/permissions.js';
import type { WorkspaceSnapshotId } from '../../domain/sandbox/sandbox.js';
import type { BrandedId, ExternalRef } from '../../shared/ids/branded-id.js';
import type { Clock } from '../common/clock.js';
import { ApplicationError } from '../common/application-error.js';
import type { IdGenerator } from '../common/id-generator.js';
import type { ProviderCatalogPort } from './provider-catalog-ports.js';

export interface ProviderConnectionPatch {
  label?: string;
  status?: ProviderConnection['status'] | 'inactive' | 'archived';
  enabled?: boolean;
  config?: Record<string, unknown>;
  externalInstallationRef?: ExternalRef<'provider_connection'> | null;
  runtimeSecretRefs?: string[];
}

export interface AgentBindingPatch {
  providerConnectionId?: ProviderConnectionId;
  threadId?: ConversationThreadId;
  displayName?: string;
  triggerMode?: AgentConversationBindingTriggerMode;
  triggerPattern?: string | null;
  requiresTrigger?: boolean;
  memoryScope?: AgentConversationBindingMemoryScope;
  memorySubject?: MemorySubject;
  workspaceSnapshotId?: WorkspaceSnapshotId | null;
  permissionPolicyIds?: PermissionPolicyId[];
  status?: AgentConversationBinding['status'];
}

export interface DiscoveredConversation {
  externalId: string;
  title?: string;
  kind: 'direct' | 'group' | 'channel' | 'service' | 'web';
  status?: 'active' | 'archived' | 'disabled';
  externalRef?: ExternalRef<'conversation'>;
}

export interface ProviderConversationDiscoveryPort {
  discover(input: {
    providerConnection: ProviderConnection;
    query?: string;
    includeArchived?: boolean;
    limit?: number;
    providerMetadata?: Record<string, unknown>;
  }): Promise<DiscoveredConversation[]>;
}

const SECRET_KEY_PATTERN =
  /(token|secret|password|credential|api[_-]?key|app[_-]?token|bot[_-]?token)/i;

function assertNoRawSecrets(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoRawSecrets(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `${path}.${key} looks like a raw secret. Store channel credentials behind runtimeSecretRefs.`,
      );
    }
    assertNoRawSecrets(nested, `${path}.${key}`);
  }
}

function assertAllowedRuntimeSecretRefs(
  provider: Provider,
  refs: string[] | undefined,
): void {
  if (refs === undefined) return;
  const allowed = new Set(provider.allowedRuntimeSecretRefs ?? []);
  const invalid = refs.filter((ref) => !allowed.has(ref));
  if (invalid.length > 0) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `runtimeSecretRefs contains unsupported refs for provider ${provider.id}: ${invalid.join(', ')}`,
    );
  }
}

function explicitProviderIdForExternalId(externalId: string): string | null {
  const separator = externalId.indexOf(':');
  if (separator <= 0) return null;
  const rawPrefix = externalId.slice(0, separator).trim().toLowerCase();
  if (!rawPrefix) return null;
  return /^[a-z][a-z0-9_-]{1,31}$/.test(rawPrefix) ? rawPrefix : null;
}

function normalizeProviderConnectionStatus(
  status: ProviderConnectionPatch['status'] | undefined,
): ProviderConnection['status'] | undefined {
  if (!status) return undefined;
  if (status === 'active' || status === 'disabled') return status;
  if (status === 'inactive' || status === 'archived') return 'disabled';
  return undefined;
}

function assertOwnedProviderConnection(
  providerConnection: ProviderConnection,
  appId: AppId,
): void {
  if (providerConnection.appId !== appId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'API key cannot access this provider connection',
    );
  }
}

function triggerModeToRequiresTrigger(
  mode: AgentConversationBindingTriggerMode,
): boolean {
  return mode === 'mention' || mode === 'keyword';
}

function memorySubjectForScope(input: {
  appId: AppId;
  agentId: AgentId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  memoryScope: AgentConversationBindingMemoryScope;
  memorySubject?: MemorySubject;
}): MemorySubject {
  if (input.memorySubject) return input.memorySubject;
  switch (input.memoryScope) {
    case 'app':
      return { kind: 'app', appId: input.appId };
    case 'agent':
      return { kind: 'agent', appId: input.appId, agentId: input.agentId };
    case 'conversation':
      return {
        kind: 'conversation',
        appId: input.appId,
        conversationId: input.conversationId,
      };
    case 'user':
      throw new ApplicationError(
        'INVALID_REQUEST',
        'memoryScope=user requires an explicit user memorySubject',
      );
  }
}

export class ProviderConnectionControlService {
  constructor(
    private readonly deps: {
      providerConnections: ProviderConnectionRepository;
      providers: ProviderCatalogPort;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async list(appId: AppId): Promise<ProviderConnection[]> {
    return await this.deps.providerConnections.listProviderConnections(appId);
  }

  async get(input: {
    appId: AppId;
    providerConnectionId: ProviderConnectionId;
  }): Promise<ProviderConnection> {
    const providerConnection =
      await this.deps.providerConnections.getProviderConnection(
        input.providerConnectionId,
      );
    if (!providerConnection) {
      throw new ApplicationError('NOT_FOUND', 'provider connection not found');
    }
    assertOwnedProviderConnection(providerConnection, input.appId);
    return providerConnection;
  }

  async create(input: {
    appId: AppId;
    providerId: ProviderId;
    label: string;
    config?: Record<string, unknown>;
    externalInstallationRef?: ExternalRef<'provider_connection'>;
    runtimeSecretRefs?: string[];
    enabled?: boolean;
  }): Promise<ProviderConnection> {
    assertNoRawSecrets(input.config, 'config');
    assertNoRawSecrets(input.externalInstallationRef, 'externalRef');
    const providers = await this.deps.providers.listProviders();
    const provider = providers.find((entry) => entry.id === input.providerId);
    if (!provider || provider.capabilityFlags.includes('placeholder')) {
      throw new ApplicationError(
        'NOT_IMPLEMENTED',
        `Provider ${input.providerId} is not implemented`,
      );
    }
    assertAllowedRuntimeSecretRefs(provider, input.runtimeSecretRefs);
    const now = this.deps.clock.now();
    const providerConnection: ProviderConnection = {
      id: this.deps.ids.generate() as ProviderConnectionId,
      appId: input.appId,
      providerId: input.providerId,
      externalInstallationRef: input.externalInstallationRef,
      label: input.label.trim(),
      status: input.enabled === false ? 'disabled' : 'active',
      config: input.config ?? {},
      runtimeSecretRefs: input.runtimeSecretRefs ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.providerConnections.saveProviderConnection(
      providerConnection,
    );
    return providerConnection;
  }

  async update(input: {
    appId: AppId;
    providerConnectionId: ProviderConnectionId;
    patch: ProviderConnectionPatch;
  }): Promise<ProviderConnection> {
    assertNoRawSecrets(input.patch.config, 'config');
    assertNoRawSecrets(input.patch.externalInstallationRef, 'externalRef');
    const existing = await this.get(input);
    const providers = await this.deps.providers.listProviders();
    const provider = providers.find(
      (entry) => entry.id === existing.providerId,
    );
    assertAllowedRuntimeSecretRefs(
      provider ?? {
        id: existing.providerId,
        displayName: String(existing.providerId),
        capabilityFlags: [],
        allowedRuntimeSecretRefs: [],
        createdAt: existing.createdAt,
      },
      input.patch.runtimeSecretRefs,
    );
    const normalizedStatus = normalizeProviderConnectionStatus(
      input.patch.status,
    );
    const patch: Parameters<
      ProviderConnectionRepository['updateProviderConnection']
    >[0]['patch'] = {
      ...(input.patch.label !== undefined
        ? { label: input.patch.label.trim() }
        : {}),
      ...(input.patch.enabled !== undefined
        ? { status: input.patch.enabled ? 'active' : 'disabled' }
        : normalizedStatus !== undefined
          ? { status: normalizedStatus }
          : {}),
      ...(input.patch.config !== undefined
        ? { config: input.patch.config }
        : {}),
      ...(input.patch.externalInstallationRef !== undefined
        ? {
            externalInstallationRef: input.patch.externalInstallationRef,
          }
        : {}),
      ...(input.patch.runtimeSecretRefs !== undefined
        ? { runtimeSecretRefs: input.patch.runtimeSecretRefs }
        : {}),
    };
    const updated =
      await this.deps.providerConnections.updateProviderConnection({
        appId: input.appId,
        id: existing.id,
        patch,
        updatedAt: this.deps.clock.now(),
      });
    if (!updated) {
      throw new ApplicationError('NOT_FOUND', 'provider connection not found');
    }
    return updated;
  }

  async disable(input: {
    appId: AppId;
    providerConnectionId: ProviderConnectionId;
  }): Promise<ProviderConnection> {
    const existing = await this.get(input);
    const disabled =
      await this.deps.providerConnections.disableProviderConnection({
        appId: input.appId,
        id: existing.id,
        updatedAt: this.deps.clock.now(),
      });
    if (!disabled) {
      throw new ApplicationError('NOT_FOUND', 'provider connection not found');
    }
    return disabled;
  }
}

export class DiscoverProviderConversationsService {
  constructor(
    private readonly deps: {
      providerConnections: ProviderConnectionRepository;
      conversations: ConversationRepository;
      discovery: ProviderConversationDiscoveryPort;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    appId: AppId;
    providerConnectionId: ProviderConnectionId;
    query?: string;
    includeArchived?: boolean;
    limit?: number;
    providerMetadata?: Record<string, unknown>;
  }) {
    const providerConnection =
      await this.deps.providerConnections.getProviderConnection(
        input.providerConnectionId,
      );
    if (!providerConnection) {
      throw new ApplicationError('NOT_FOUND', 'provider connection not found');
    }
    assertOwnedProviderConnection(providerConnection, input.appId);
    if (providerConnection.status !== 'active') {
      throw new ApplicationError('CONFLICT', 'provider connection is disabled');
    }
    const discovered = await this.deps.discovery.discover({
      providerConnection,
      query: input.query,
      includeArchived: input.includeArchived,
      limit: input.limit,
      providerMetadata: input.providerMetadata,
    });
    const now = this.deps.clock.now();
    const conversations = [];
    for (const item of discovered) {
      const explicitProviderId = explicitProviderIdForExternalId(
        item.externalId,
      );
      if (
        explicitProviderId &&
        explicitProviderId !== providerConnection.providerId
      ) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `Discovered conversation externalId "${item.externalId}" has provider prefix "${explicitProviderId}:" but provider connection ${providerConnection.id} is ${providerConnection.providerId}.`,
        );
      }
      const existing =
        await this.deps.conversations.getConversationByExternalRef({
          appId: input.appId,
          providerId: providerConnection.providerId,
          providerConnectionId: providerConnection.id,
          externalConversationId: item.externalId,
        });
      const conversation = {
        id:
          existing?.id ??
          (`conversation:${providerConnection.id}:${item.externalId}` as ConversationId),
        appId: input.appId,
        providerConnectionId: providerConnection.id,
        externalRef:
          item.externalRef ??
          ({
            kind: 'conversation',
            value: item.externalId,
          } as ExternalRef<'conversation'>),
        kind: item.kind,
        title: item.title,
        status: item.status ?? 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.deps.conversations.saveConversation(conversation);
      conversations.push(conversation);
    }
    return conversations;
  }
}

export class AgentConversationBindingControlService {
  constructor(
    private readonly deps: {
      agents: AgentRepository;
      providerConnections: ProviderConnectionRepository;
      conversations: ConversationRepository;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async list(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentConversationBinding[]> {
    const agent = await this.deps.agents.getAgent(input.agentId);
    if (!agent) throw new ApplicationError('NOT_FOUND', 'Agent not found');
    if (agent.appId !== input.appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this agent',
      );
    }
    return await this.deps.providerConnections.listAgentConversationBindings(
      input.appId,
      input.agentId,
    );
  }

  async enable(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: AgentBindingPatch;
  }): Promise<AgentConversationBinding> {
    return await this.upsert({ ...input, requireExisting: false });
  }

  async update(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: AgentBindingPatch;
  }): Promise<AgentConversationBinding> {
    return await this.upsert({ ...input, requireExisting: true });
  }

  async disable(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
  }): Promise<AgentConversationBinding> {
    await this.assertAgent(input.appId, input.agentId);
    const disabled =
      await this.deps.providerConnections.disableAgentConversationBinding({
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        threadId: input.threadId,
        updatedAt: this.deps.clock.now(),
      });
    if (!disabled) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Agent conversation binding not found',
      );
    }
    return disabled;
  }

  private async upsert(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: AgentBindingPatch;
    requireExisting: boolean;
  }): Promise<AgentConversationBinding> {
    await this.assertAgent(input.appId, input.agentId);
    const conversation = await this.deps.conversations.getConversation(
      input.conversationId,
    );
    if (!conversation) {
      throw new ApplicationError('NOT_FOUND', 'Conversation not found');
    }
    if (conversation.appId !== input.appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this conversation',
      );
    }
    const threadId = input.patch.threadId;
    if (threadId) {
      const thread = await this.deps.conversations.getThread(threadId);
      if (!thread || thread.conversationId !== conversation.id) {
        throw new ApplicationError(
          'NOT_FOUND',
          'Conversation thread not found',
        );
      }
    }
    const providerConnectionId =
      input.patch.providerConnectionId ??
      conversation.providerConnectionId ??
      (conversation as { providerConnectionId?: ProviderConnectionId })
        .providerConnectionId;
    const providerConnection =
      await this.deps.providerConnections.getProviderConnection(
        providerConnectionId,
      );
    if (!providerConnection) {
      throw new ApplicationError('NOT_FOUND', 'provider connection not found');
    }
    assertOwnedProviderConnection(providerConnection, input.appId);
    const existing =
      await this.deps.providerConnections.getAgentConversationBinding({
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        threadId,
      });
    if (input.requireExisting && !existing) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Agent conversation binding not found',
      );
    }
    const triggerMode =
      input.patch.triggerMode ?? existing?.triggerMode ?? 'always';
    const triggerModeWasPatched = input.patch.triggerMode !== undefined;
    const memoryScope =
      input.patch.memoryScope ?? existing?.memoryScope ?? 'conversation';
    const now = this.deps.clock.now();
    const binding: AgentConversationBinding = {
      id:
        existing?.id ??
        (this.deps.ids.generate() as BrandedId<'AgentConversationBindingId'>),
      appId: input.appId,
      agentId: input.agentId,
      providerConnectionId: providerConnection.id,
      conversationId: conversation.id,
      ...(threadId
        ? { threadId }
        : existing?.threadId
          ? { threadId: existing.threadId }
          : {}),
      displayName:
        input.patch.displayName ??
        existing?.displayName ??
        conversation.title ??
        conversation.id,
      status:
        input.patch.status ??
        (input.requireExisting ? existing?.status : undefined) ??
        'active',
      triggerMode,
      triggerPattern:
        input.patch.triggerPattern === null
          ? undefined
          : (input.patch.triggerPattern ?? existing?.triggerPattern),
      requiresTrigger:
        input.patch.requiresTrigger ??
        (triggerModeWasPatched
          ? triggerModeToRequiresTrigger(triggerMode)
          : existing?.requiresTrigger) ??
        triggerModeToRequiresTrigger(triggerMode),
      memoryScope,
      memorySubject: memorySubjectForScope({
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        threadId: threadId ?? existing?.threadId,
        memoryScope,
        memorySubject: input.patch.memorySubject,
      }),
      workspaceSnapshotId:
        input.patch.workspaceSnapshotId === null
          ? undefined
          : (input.patch.workspaceSnapshotId ?? existing?.workspaceSnapshotId),
      permissionPolicyIds:
        input.patch.permissionPolicyIds ?? existing?.permissionPolicyIds ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.providerConnections.saveAgentConversationBinding(binding);
    return binding;
  }

  private async assertAgent(appId: AppId, agentId: AgentId): Promise<void> {
    const agent = await this.deps.agents.getAgent(agentId);
    if (!agent) throw new ApplicationError('NOT_FOUND', 'Agent not found');
    if (agent.appId !== appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this agent',
      );
    }
  }
}
