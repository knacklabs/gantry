import { ApplicationError } from '../common/application-error.js';
import type { Agent, AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentRepository,
  ChannelInstallationRepository,
  ConversationRepository,
} from '../../domain/ports/repositories.js';
import type { ConversationId } from '../../domain/conversation/conversation.js';

export interface AgentDmAccessProviderEntry {
  provider: string;
  userIds: string[];
  adminUserId?: string;
}

export interface AgentDmAccessView {
  agentId: AgentId;
  dmAccess: {
    entries: AgentDmAccessProviderEntry[];
  };
  updatedAt: string;
}

export type AgentDmResolution =
  | { status: 'none' }
  | { status: 'single'; agent: Agent }
  | { status: 'ambiguous'; agents: Agent[] };

export class AgentDmAccessAdministrationService {
  constructor(
    private readonly repositories: {
      agents: AgentRepository;
      channelInstallations?: ChannelInstallationRepository;
      conversations?: ConversationRepository;
    },
    private readonly clock: { now(): string } = {
      now: () => new Date().toISOString(),
    },
  ) {}

  async getDmAccess(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<AgentDmAccessView> {
    await this.requireAgent(input.appId, input.agentId);
    const [rows, approvers] = await Promise.all([
      this.repositories.agents.listAgentDmAccess(input),
      this.repositories.agents.listAgentDmApprovers(input),
    ]);
    return {
      agentId: input.agentId,
      dmAccess: { entries: groupDmAccessRows(rows, approvers) },
      updatedAt: this.clock.now(),
    };
  }

  async replaceDmAccess(input: {
    appId: AppId;
    agentId: AgentId;
    entries: AgentDmAccessProviderEntry[];
  }): Promise<AgentDmAccessView> {
    await this.requireAgent(input.appId, input.agentId);
    const updatedAt = this.clock.now();
    const result = await this.repositories.agents.replaceAgentDmAccessPolicy({
      appId: input.appId,
      agentId: input.agentId,
      accessEntries: flattenDmAccessEntries(input.entries),
      approverEntries: flattenDmApproverEntries(input.entries),
      updatedAt,
    });
    return {
      agentId: input.agentId,
      dmAccess: { entries: groupDmAccessRows(result.access, result.approvers) },
      updatedAt,
    };
  }

  async resolveDmAgent(input: {
    appId: AppId;
    providerId: string;
    externalUserId: string;
  }): Promise<AgentDmResolution> {
    const providerId = normalizeProviderId(input.providerId);
    const externalUserId = normalizeExternalUserId(input.externalUserId);
    if (!providerId || !externalUserId) return { status: 'none' };
    const agents = await this.repositories.agents.findAgentsByDmAccess({
      appId: input.appId,
      providerId,
      externalUserId,
    });
    if (agents.length === 0) return { status: 'none' };
    if (agents.length === 1) return { status: 'single', agent: agents[0]! };
    return { status: 'ambiguous', agents };
  }

  async isDmApproverAllowed(input: {
    appId: AppId;
    providerId: string;
    channelJid: string;
    userId: string;
  }): Promise<boolean | null> {
    if (
      !this.repositories.channelInstallations ||
      !this.repositories.conversations
    ) {
      return null;
    }
    const conversationId = `conversation:${input.channelJid}` as ConversationId;
    const conversation =
      await this.repositories.conversations.getConversation(conversationId);
    if (!conversation || conversation.appId !== input.appId) return null;
    if (conversation.kind !== 'direct') return null;

    const bindings =
      await this.repositories.channelInstallations.listAgentChannelBindings(
        input.appId,
      );
    const activeBindings = bindings.filter(
      (candidate) =>
        candidate.conversationId === conversationId &&
        candidate.status === 'active',
    );
    if (activeBindings.length !== 1) return false;
    const binding = activeBindings[0]!;

    const providerId = normalizeProviderId(input.providerId);
    const userId = normalizeExternalUserId(input.userId);
    if (!providerId || !userId) return false;

    const approvers = await this.repositories.agents.listAgentDmApprovers({
      appId: input.appId,
      agentId: binding.agentId,
    });
    return approvers.some(
      (approver) =>
        normalizeProviderId(approver.providerId) === providerId &&
        normalizeExternalUserId(approver.externalUserId) === userId,
    );
  }

  private async requireAgent(appId: AppId, agentId: AgentId): Promise<Agent> {
    const agent = await this.repositories.agents.getAgent(agentId);
    if (!agent || agent.appId !== appId) {
      throw new ApplicationError('NOT_FOUND', `Agent not found: ${agentId}`);
    }
    if (agent.status !== 'active') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Agent is not active: ${agentId}`,
      );
    }
    return agent;
  }
}

export function flattenDmAccessEntries(
  entries: AgentDmAccessProviderEntry[],
): Array<{ providerId: string; externalUserId: string }> {
  const flattened: Array<{ providerId: string; externalUserId: string }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const providerId = normalizeProviderId(entry.provider);
    if (!providerId || !isValidProviderId(providerId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Invalid DM access provider: ${entry.provider}`,
      );
    }
    for (const rawUserId of entry.userIds) {
      const externalUserId = normalizeExternalUserId(rawUserId);
      if (!externalUserId || !isValidExternalUserId(externalUserId)) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          `Invalid DM access user id for ${providerId}: ${rawUserId}`,
        );
      }
      const key = `${providerId}\n${externalUserId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flattened.push({ providerId, externalUserId });
    }
  }
  return flattened.sort((a, b) =>
    `${a.providerId}:${a.externalUserId}`.localeCompare(
      `${b.providerId}:${b.externalUserId}`,
    ),
  );
}

export function flattenDmApproverEntries(
  entries: AgentDmAccessProviderEntry[],
): Array<{ providerId: string; externalUserId: string }> {
  const flattened: Array<{ providerId: string; externalUserId: string }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const providerId = normalizeProviderId(entry.provider);
    if (!providerId || !isValidProviderId(providerId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Invalid DM access provider: ${entry.provider}`,
      );
    }
    if (!entry.adminUserId) continue;
    const externalUserId = normalizeExternalUserId(entry.adminUserId);
    if (!externalUserId || !isValidExternalUserId(externalUserId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Invalid DM admin user id for ${providerId}: ${entry.adminUserId}`,
      );
    }
    if (seen.has(providerId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Only one DM admin is allowed per provider: ${providerId}`,
      );
    }
    seen.add(providerId);
    flattened.push({ providerId, externalUserId });
  }
  return flattened.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function groupDmAccessRows(
  rows: Array<{ providerId: string; externalUserId: string }>,
  approvers: Array<{ providerId: string; externalUserId: string }> = [],
): AgentDmAccessProviderEntry[] {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const provider = normalizeProviderId(row.providerId);
    const userId = normalizeExternalUserId(row.externalUserId);
    if (!provider || !userId) continue;
    const existing = grouped.get(provider) ?? [];
    existing.push(userId);
    grouped.set(provider, existing);
  }
  const adminByProvider = new Map(
    approvers.map((approver) => [
      normalizeProviderId(approver.providerId),
      normalizeExternalUserId(approver.externalUserId),
    ]),
  );
  for (const provider of adminByProvider.keys()) {
    if (!grouped.has(provider)) grouped.set(provider, []);
  }
  return [...grouped.entries()]
    .map(([provider, userIds]) => {
      const adminUserId = adminByProvider.get(provider);
      return {
        provider,
        userIds: [...new Set(userIds)].sort((a, b) => a.localeCompare(b)),
        ...(adminUserId ? { adminUserId } : {}),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function normalizeProviderId(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function normalizeExternalUserId(value: string): string {
  return String(value ?? '').trim();
}

function isValidProviderId(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function isValidExternalUserId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
}
