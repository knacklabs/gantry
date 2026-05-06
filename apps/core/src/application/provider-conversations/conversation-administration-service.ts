import type { AppId } from '../../domain/app/app.js';
import type {
  ProviderConnection,
  ProviderId,
} from '../../domain/provider/provider.js';
import type {
  Conversation,
  ConversationId,
} from '../../domain/conversation/conversation.js';
import type {
  ProviderConnectionRepository,
  ConversationRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';

export interface ConversationMembershipValidationInput {
  providerId: ProviderId;
  providerConnection: ProviderConnection;
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
      providerConnections: ProviderConnectionRepository;
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
    const { conversation, providerConnection } =
      await this.requireConversation(input);
    if (conversation.kind === 'direct') {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Conversation approvers are not supported for direct conversations; use the agent DM admin for direct/private prompts',
      );
    }
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
        providerId: providerConnection.providerId,
        providerConnection,
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
    conversationJid: string;
    userId: string;
  }): Promise<boolean> {
    const userId = input.userId.trim();
    if (!userId) return false;
    const conversation = await this.findConversationForJid(input);
    if (!conversation) return false;
    if (conversation.kind === 'direct') return false;
    const approvers =
      await this.repositories.conversations.listConversationApprovers(
        conversation.id,
      );
    if (!approvers.some((approver) => approver.externalUserId === userId)) {
      return false;
    }
    const providerConnection =
      await this.repositories.providerConnections.getProviderConnection(
        conversation.providerConnectionId,
      );
    if (!providerConnection) return false;
    const validation = await this.validateMembership({
      providerId: providerConnection.providerId,
      providerConnection,
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
    providerConnection: ProviderConnection;
  }> {
    const conversation = await this.repositories.conversations.getConversation(
      input.conversationId,
    );
    if (!conversation || conversation.appId !== input.appId) {
      throw new ApplicationError('NOT_FOUND', 'Conversation not found');
    }
    const providerConnection =
      await this.repositories.providerConnections.getProviderConnection(
        conversation.providerConnectionId,
      );
    if (!providerConnection || providerConnection.appId !== input.appId) {
      throw new ApplicationError('NOT_FOUND', 'provider connection not found');
    }
    return { conversation, providerConnection };
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
    conversationJid: string;
  }): Promise<Conversation | null> {
    const direct = await this.repositories.conversations.getConversation(
      `conversation:${input.conversationJid}` as ConversationId,
    );
    if (direct?.appId === input.appId) return direct;
    const candidates = conversationExternalRefCandidates({
      providerId: String(input.providerId),
      conversationJid: input.conversationJid,
    });
    for (const candidate of candidates) {
      const conversation =
        await this.repositories.conversations.findConversationByExternalValue({
          appId: input.appId,
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
