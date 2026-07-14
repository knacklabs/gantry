import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderId,
} from '../../domain/provider/provider.js';
import type {
  Conversation,
  ConversationId,
} from '../../domain/conversation/conversation.js';
import { canonicalConversationThreadId } from '../../domain/conversation/conversation.js';
import type {
  ProviderAccountRepository,
  ConversationRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';

export interface ConversationMembershipValidationInput {
  providerId: ProviderId;
  providerAccount: ProviderAccount;
  conversation: Conversation;
  userIds: string[];
}

export interface ConversationMembershipValidationResult {
  validUserIds: string[];
  invalidUserIds: string[];
  reason?: string;
}

export interface ConversationMembershipValidator {
  validateControlApprovers(
    input: ConversationMembershipValidationInput,
  ): Promise<ConversationMembershipValidationResult>;
}

export interface ConversationAdminSummary {
  controlAllowlist: { userIds: string[] };
}

export class ConversationAdministrationService {
  constructor(
    private readonly repositories: {
      providerAccounts: ProviderAccountRepository;
      conversations: ConversationRepository;
    },
    private readonly membershipValidator?: ConversationMembershipValidator,
  ) {}

  async getAdminSummary(input: {
    appId: AppId;
    conversationId: ConversationId;
  }): Promise<ConversationAdminSummary> {
    const { conversation } = await this.requireConversation(input);
    const approvers =
      await this.repositories.conversations.listConversationApprovers(
        conversation.id,
      );
    return {
      controlAllowlist: {
        userIds: approvers.map((approver) => approver.externalUserId),
      },
    };
  }

  async replaceControlAllowlist(input: {
    appId: AppId;
    conversationId: ConversationId;
    userIds: string[];
    updatedAt: string;
  }): Promise<{ userIds: string[] }> {
    const { conversation, providerAccount } =
      await this.requireConversation(input);
    const userIds = normalizeUserIds(input.userIds);
    const invalidShape = userIds.filter((id) => !isValidExternalUserId(id));
    if (invalidShape.length > 0) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Invalid control approver user ids: ${invalidShape.join(', ')}`,
      );
    }
    if (userIds.length > 0) {
      const validation = await this.validateMembership({
        providerId: providerAccount.providerId,
        providerAccount,
        conversation,
        userIds,
      });
      if (validation.invalidUserIds.length > 0) {
        throw new ApplicationError(
          'INVALID_CONTROL_ALLOWLIST',
          [
            'Control approvers must be members of the conversation.',
            `Invalid: ${validation.invalidUserIds.join(', ')}`,
            validation.reason,
          ]
            .filter(Boolean)
            .join(' '),
        );
      }
    }
    const rows =
      await this.repositories.conversations.replaceConversationApprovers({
        appId: input.appId,
        conversationId: conversation.id,
        externalUserIds: userIds,
        updatedAt: input.updatedAt,
      });
    return { userIds: rows.map((row) => row.externalUserId) };
  }

  async isControlApproverAllowed(input: {
    appId: AppId;
    providerId: ProviderId;
    providerAccountId: ProviderAccountId;
    agentId: AgentId;
    conversationJid: string;
    threadId?: string;
    userId: string;
  }): Promise<boolean> {
    const userId = input.userId.trim();
    if (!userId) return false;
    const conversation = await this.findConversationForJid(input);
    if (!conversation) return false;
    if (conversation.providerAccountId !== input.providerAccountId)
      return false;
    const threadId = canonicalConversationThreadId({
      conversation,
      threadId: input.threadId,
    });
    const install =
      await this.repositories.providerAccounts.getConversationInstall({
        appId: input.appId,
        agentId: input.agentId,
        conversationId: conversation.id,
        ...(threadId ? { threadId } : {}),
      });
    if (!install || install.status !== 'active') return false;
    const approvers =
      await this.repositories.conversations.listConversationApprovers(
        conversation.id,
      );
    if (!approvers.some((approver) => approver.externalUserId === userId)) {
      return false;
    }
    const providerAccount =
      await this.repositories.providerAccounts.getProviderAccount(
        conversation.providerAccountId,
      );
    if (!providerAccount) return false;
    const validation = await this.validateMembership({
      providerId: providerAccount.providerId,
      providerAccount,
      conversation,
      userIds: [userId],
    });
    return validation.validUserIds.includes(userId);
  }

  private async requireConversation(input: {
    appId: AppId;
    conversationId: ConversationId;
  }): Promise<{
    conversation: Conversation;
    providerAccount: ProviderAccount;
  }> {
    const conversation = await this.repositories.conversations.getConversation(
      input.conversationId,
    );
    if (!conversation || conversation.appId !== input.appId) {
      throw new ApplicationError('NOT_FOUND', 'Conversation not found');
    }
    const providerAccount =
      await this.repositories.providerAccounts.getProviderAccount(
        conversation.providerAccountId,
      );
    if (!providerAccount || providerAccount.appId !== input.appId) {
      throw new ApplicationError('NOT_FOUND', 'provider account not found');
    }
    return { conversation, providerAccount };
  }

  private async validateMembership(
    input: ConversationMembershipValidationInput,
  ): Promise<ConversationMembershipValidationResult> {
    const providerId = String(input.providerId);
    if (
      providerId === 'app' ||
      providerId === 'web' ||
      providerId === 'local'
    ) {
      return this.validateKnownConversationParticipants(input);
    }
    if (this.membershipValidator) {
      return this.membershipValidator.validateControlApprovers(input);
    }
    return this.validateKnownConversationParticipants(input);
  }

  private async validateKnownConversationParticipants(
    input: ConversationMembershipValidationInput,
  ): Promise<ConversationMembershipValidationResult> {
    const knownMembers = new Set(
      await this.repositories.conversations.listParticipantExternalUserIds(
        input.conversation.id,
      ),
    );
    return {
      validUserIds: input.userIds.filter((id) => knownMembers.has(id)),
      invalidUserIds: input.userIds.filter((id) => !knownMembers.has(id)),
      reason:
        knownMembers.size === 0
          ? 'No conversation participant records are available.'
          : undefined,
    };
  }

  private async findConversationForJid(input: {
    appId: AppId;
    providerId: ProviderId;
    providerAccountId: ProviderAccountId;
    conversationJid: string;
  }): Promise<Conversation | null> {
    const direct = await this.repositories.conversations.getConversation(
      `conversation:${input.conversationJid}` as ConversationId,
    );
    if (
      direct?.appId === input.appId &&
      direct.providerAccountId === input.providerAccountId &&
      direct.status === 'active'
    ) {
      return direct;
    }
    const candidates = conversationExternalRefCandidates({
      providerId: String(input.providerId),
      conversationJid: input.conversationJid,
    });
    for (const candidate of candidates) {
      const conversation =
        await this.repositories.conversations.getConversationByExternalRef({
          appId: input.appId,
          providerId: input.providerId,
          providerAccountId: input.providerAccountId,
          externalConversationId: candidate,
        });
      if (conversation) return conversation;
    }
    return null;
  }
}

function conversationExternalRefCandidates(input: {
  providerId: string;
  conversationJid: string;
}): string[] {
  const candidates = new Set<string>();
  const jid = input.conversationJid.trim();
  if (!jid) return [];
  candidates.add(jid);
  const providerPrefix = `${input.providerId.trim().toLowerCase()}:`;
  if (providerPrefix !== ':' && jid.startsWith(providerPrefix)) {
    candidates.add(jid.slice(providerPrefix.length));
  }
  const separator = jid.indexOf(':');
  if (separator > 0) {
    candidates.add(jid.slice(separator + 1));
  }
  return [...candidates].filter(Boolean);
}

function normalizeUserIds(userIds: string[]): string[] {
  return [
    ...new Set(
      userIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function isValidExternalUserId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
}
