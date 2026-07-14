import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ConversationInstall,
  ConversationInstallMemoryScope,
  Provider,
  ProviderAccount,
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../../domain/conversation/conversation.js';
import type {
  MemorySubject,
  MemorySubjectRoute,
} from '../../domain/memory/memory.js';
import type {
  AgentRepository,
  ProviderAccountRepository,
  ConversationRepository,
} from '../../domain/ports/repositories.js';
import type { PermissionPolicyId } from '../../domain/permissions/permissions.js';
import type { WorkspaceSnapshotId } from '../../domain/sandbox/sandbox.js';
import type { BrandedId, ExternalRef } from '../../shared/ids/branded-id.js';
import type { Clock } from '../common/clock.js';
import { ApplicationError } from '../common/application-error.js';
import type { IdGenerator } from '../common/id-generator.js';
import type { ProviderCatalogPort } from './provider-catalog-ports.js';
import {
  isForbiddenRuntimeSecretEnvName,
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../../domain/ports/runtime-secret-provider.js';
import { isProviderRuntimeSecretRefTarget } from '../../domain/provider/provider-runtime-secret-keys.js';

export interface ProviderAccountPatch {
  label?: string;
  status?: ProviderAccount['status'] | 'inactive' | 'archived';
  enabled?: boolean;
  config?: Record<string, unknown>;
  externalInstallationRef?: ExternalRef<'provider_account'> | null;
  runtimeSecretRefs?: Record<string, string>;
}

export interface ConversationInstallPatch {
  providerAccountId?: ProviderAccountId;
  threadId?: ConversationThreadId;
  displayName?: string;
  memoryScope?: ConversationInstallMemoryScope;
  memorySubject?: MemorySubject;
  routeConfig?: MemorySubjectRoute;
  workspaceSnapshotId?: WorkspaceSnapshotId | null;
  permissionPolicyIds?: PermissionPolicyId[];
  status?: ConversationInstall['status'];
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
    providerAccount: ProviderAccount;
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
  refs: Record<string, string> | undefined,
): void {
  if (refs === undefined) return;
  const allowed = new Set(provider.allowedRuntimeSecretKeys ?? []);
  const invalid = Object.keys(refs).filter((key) => !allowed.has(key));
  if (invalid.length > 0) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `runtimeSecretRefs contains unsupported keys for provider ${provider.id}: ${invalid.join(', ')}`,
    );
  }
  for (const [key, ref] of Object.entries(refs)) {
    try {
      const normalized = normalizeRuntimeSecretRefString(
        ref,
        `runtimeSecretRefs.${key}`,
      );
      const parsed = parseRuntimeSecretRefString(normalized);
      if (
        parsed.source === 'env' &&
        isForbiddenRuntimeSecretEnvName(parsed.name)
      ) {
        throw new Error(
          `${parsed.name} is not allowed for provider '${provider.id}' runtime secret ref ${normalized}. Use a channel runtime secret name, not model/provider credential authority.`,
        );
      }
      if (!isProviderRuntimeSecretRefTarget(provider.id, key, normalized)) {
        throw new Error(
          `runtimeSecretRefs.${key} must point to the canonical ${provider.id} credential for ${key}.`,
        );
      }
      refs[key] = normalized;
    } catch (error) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        error instanceof Error
          ? error.message
          : `Invalid runtimeSecretRefs.${key}`,
      );
    }
  }
}

function explicitProviderIdForExternalId(externalId: string): string | null {
  const separator = externalId.indexOf(':');
  if (separator <= 0) return null;
  const rawPrefix = externalId.slice(0, separator).trim().toLowerCase();
  if (!rawPrefix) return null;
  return /^[a-z][a-z0-9_-]{1,31}$/.test(rawPrefix) ? rawPrefix : null;
}

function normalizeProviderAccountStatus(
  status: ProviderAccountPatch['status'] | undefined,
): ProviderAccount['status'] | undefined {
  if (!status) return undefined;
  if (status === 'active' || status === 'disabled') return status;
  if (status === 'inactive' || status === 'archived') return 'disabled';
  return undefined;
}

function assertOwnedProviderAccount(
  providerAccount: ProviderAccount,
  appId: AppId,
): void {
  if (providerAccount.appId !== appId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'API key cannot access this provider account',
    );
  }
}

function memorySubjectForScope(input: {
  appId: AppId;
  agentId: AgentId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  memoryScope: ConversationInstallMemoryScope;
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

export class ProviderAccountControlService {
  constructor(
    private readonly deps: {
      agents: AgentRepository;
      providerAccounts: ProviderAccountRepository;
      providers: ProviderCatalogPort;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async list(appId: AppId): Promise<ProviderAccount[]> {
    return await this.deps.providerAccounts.listProviderAccounts(appId);
  }

  async get(input: {
    appId: AppId;
    providerAccountId: ProviderAccountId;
  }): Promise<ProviderAccount> {
    const providerAccount = await this.deps.providerAccounts.getProviderAccount(
      input.providerAccountId,
    );
    if (!providerAccount) {
      throw new ApplicationError('NOT_FOUND', 'provider account not found');
    }
    assertOwnedProviderAccount(providerAccount, input.appId);
    return providerAccount;
  }

  async create(input: {
    appId: AppId;
    agentId: AgentId;
    providerId: ProviderId;
    label: string;
    config?: Record<string, unknown>;
    externalInstallationRef?: ExternalRef<'provider_account'>;
    runtimeSecretRefs?: Record<string, string>;
    enabled?: boolean;
  }): Promise<ProviderAccount> {
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
    const agent = await this.deps.agents.getAgent(input.agentId);
    if (!agent) throw new ApplicationError('NOT_FOUND', 'Agent not found');
    if (agent.appId !== input.appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this agent',
      );
    }
    assertAllowedRuntimeSecretRefs(provider, input.runtimeSecretRefs);
    const now = this.deps.clock.now();
    const providerAccount: ProviderAccount = {
      id: this.deps.ids.generate() as ProviderAccountId,
      appId: input.appId,
      agentId: input.agentId,
      providerId: input.providerId,
      externalIdentityRef: input.externalInstallationRef,
      label: input.label.trim(),
      status: input.enabled === false ? 'disabled' : 'active',
      config: input.config ?? {},
      runtimeSecretRefs: input.runtimeSecretRefs ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.providerAccounts.saveProviderAccount(providerAccount);
    return providerAccount;
  }

  async update(input: {
    appId: AppId;
    providerAccountId: ProviderAccountId;
    patch: ProviderAccountPatch;
  }): Promise<ProviderAccount> {
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
        allowedRuntimeSecretKeys: [],
        createdAt: existing.createdAt,
      },
      input.patch.runtimeSecretRefs,
    );
    const normalizedStatus = normalizeProviderAccountStatus(input.patch.status);
    const patch: Parameters<
      ProviderAccountRepository['updateProviderAccount']
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
            externalIdentityRef: input.patch.externalInstallationRef,
          }
        : {}),
      ...(input.patch.runtimeSecretRefs !== undefined
        ? { runtimeSecretRefs: input.patch.runtimeSecretRefs }
        : {}),
    };
    const updated = await this.deps.providerAccounts.updateProviderAccount({
      appId: input.appId,
      id: existing.id,
      patch,
      updatedAt: this.deps.clock.now(),
    });
    if (!updated) {
      throw new ApplicationError('NOT_FOUND', 'provider account not found');
    }
    return updated;
  }

  async disable(input: {
    appId: AppId;
    providerAccountId: ProviderAccountId;
  }): Promise<ProviderAccount> {
    const existing = await this.get(input);
    const disabled = await this.deps.providerAccounts.disableProviderAccount({
      appId: input.appId,
      id: existing.id,
      updatedAt: this.deps.clock.now(),
    });
    if (!disabled) {
      throw new ApplicationError('NOT_FOUND', 'provider account not found');
    }
    return disabled;
  }
}

export class DiscoverProviderConversationsService {
  constructor(
    private readonly deps: {
      providerAccounts: ProviderAccountRepository;
      conversations: ConversationRepository;
      discovery: ProviderConversationDiscoveryPort;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async execute(input: {
    appId: AppId;
    providerAccountId: ProviderAccountId;
    query?: string;
    includeArchived?: boolean;
    limit?: number;
    providerMetadata?: Record<string, unknown>;
  }) {
    const providerAccount = await this.deps.providerAccounts.getProviderAccount(
      input.providerAccountId,
    );
    if (!providerAccount) {
      throw new ApplicationError('NOT_FOUND', 'provider account not found');
    }
    assertOwnedProviderAccount(providerAccount, input.appId);
    if (providerAccount.status !== 'active') {
      throw new ApplicationError('CONFLICT', 'provider account is disabled');
    }
    const discovered = await this.deps.discovery.discover({
      providerAccount,
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
        explicitProviderId !== providerAccount.providerId
      ) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `Discovered conversation externalId "${item.externalId}" has provider prefix "${explicitProviderId}:" but provider account ${providerAccount.id} is ${providerAccount.providerId}.`,
        );
      }
      const existing =
        await this.deps.conversations.getConversationByExternalRef({
          appId: input.appId,
          providerId: providerAccount.providerId,
          providerAccountId: providerAccount.id,
          externalConversationId: item.externalId,
        });
      const conversation = {
        id:
          existing?.id ??
          (`conversation:${providerAccount.id}:${item.externalId}` as ConversationId),
        appId: input.appId,
        providerAccountId: providerAccount.id,
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

export class ConversationInstallControlService {
  constructor(
    private readonly deps: {
      agents: AgentRepository;
      providerAccounts: ProviderAccountRepository;
      conversations: ConversationRepository;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async list(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<ConversationInstall[]> {
    const agent = await this.deps.agents.getAgent(input.agentId);
    if (!agent) throw new ApplicationError('NOT_FOUND', 'Agent not found');
    if (agent.appId !== input.appId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this agent',
      );
    }
    return await this.deps.providerAccounts.listConversationInstalls(
      input.appId,
      input.agentId,
    );
  }

  async enable(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: ConversationInstallPatch;
  }): Promise<ConversationInstall> {
    return await this.upsert({ ...input, requireExisting: false });
  }

  async update(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: ConversationInstallPatch;
  }): Promise<ConversationInstall> {
    return await this.upsert({ ...input, requireExisting: true });
  }

  async disable(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
  }): Promise<ConversationInstall> {
    await this.assertAgent(input.appId, input.agentId);
    const disabled =
      await this.deps.providerAccounts.disableConversationInstall({
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        threadId: input.threadId,
        updatedAt: this.deps.clock.now(),
      });
    if (!disabled) {
      throw new ApplicationError('NOT_FOUND', 'Conversation install not found');
    }
    return disabled;
  }

  private async upsert(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId: ConversationId;
    patch: ConversationInstallPatch;
    requireExisting: boolean;
  }): Promise<ConversationInstall> {
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
    const providerAccountId =
      input.patch.providerAccountId ?? conversation.providerAccountId;
    if (providerAccountId !== conversation.providerAccountId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Conversation install provider account must match the conversation provider account',
      );
    }
    const providerAccount =
      await this.deps.providerAccounts.getProviderAccount(providerAccountId);
    if (!providerAccount) {
      throw new ApplicationError('NOT_FOUND', 'provider account not found');
    }
    assertOwnedProviderAccount(providerAccount, input.appId);
    if (providerAccount.agentId !== input.agentId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Provider account is owned by a different agent',
      );
    }
    const existing = await this.deps.providerAccounts.getConversationInstall({
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId,
      exactThreadId: Boolean(threadId),
    });
    if (input.requireExisting && !existing) {
      throw new ApplicationError('NOT_FOUND', 'Conversation install not found');
    }
    const memoryScope =
      input.patch.memoryScope ?? existing?.memoryScope ?? 'conversation';
    const memorySubject = memorySubjectForScope({
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: threadId ?? existing?.threadId,
      memoryScope,
      memorySubject: input.patch.memorySubject,
    });
    if (!input.patch.memorySubject && existing?.memorySubject?.route) {
      memorySubject.route = existing.memorySubject.route;
    }
    if (input.patch.routeConfig !== undefined) {
      memorySubject.route = {
        ...(memorySubject.route ?? {}),
        ...input.patch.routeConfig,
      };
    }
    const now = this.deps.clock.now();
    const install: ConversationInstall = {
      id:
        existing?.id ??
        (this.deps.ids.generate() as BrandedId<'ConversationInstallId'>),
      appId: input.appId,
      agentId: input.agentId,
      providerAccountId: providerAccount.id,
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
      senderPolicy: 'provider_native',
      controlPolicy: 'conversation_approvers',
      memoryScope,
      memorySubject,
      workspaceSnapshotId:
        input.patch.workspaceSnapshotId === null
          ? undefined
          : (input.patch.workspaceSnapshotId ?? existing?.workspaceSnapshotId),
      permissionPolicyIds:
        input.patch.permissionPolicyIds ?? existing?.permissionPolicyIds ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.providerAccounts.saveConversationInstall(install);
    return install;
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
