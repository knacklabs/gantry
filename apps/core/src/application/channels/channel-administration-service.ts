import type { AppId } from '../../domain/app/app.js';
import type {
  ChannelInstallation,
  ChannelProviderId,
} from '../../domain/channel/channel.js';
import type {
  Conversation,
  ConversationId,
} from '../../domain/conversation/conversation.js';
import type {
  ChannelInstallationRepository,
  ConversationRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';

export interface ChannelMembershipValidationInput {
  providerId: ChannelProviderId;
  installation: ChannelInstallation;
  conversation: Conversation;
  userIds: string[];
}

export interface ChannelMembershipValidationResult {
  validUserIds: string[];
  invalidUserIds: string[];
  reason?: string;
}

export interface ChannelMembershipValidator {
  validateControlApprovers(
    input: ChannelMembershipValidationInput,
  ): Promise<ChannelMembershipValidationResult>;
}

export interface ChannelAdminSummary {
  controlAllowlist: { userIds: string[] };
}

export class ChannelAdministrationService {
  constructor(
    private readonly repositories: {
      channelInstallations: ChannelInstallationRepository;
      conversations: ConversationRepository;
    },
    private readonly membershipValidator?: ChannelMembershipValidator,
  ) {}

  async getAdminSummary(input: {
    appId: AppId;
    conversationId: ConversationId;
  }): Promise<ChannelAdminSummary> {
    const { installation, conversation } = await this.requireChannel(input);
    const approvers =
      await this.repositories.conversations.listChannelControlApprovers(
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
    const { conversation, installation } = await this.requireChannel(input);
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
        providerId: installation.providerId,
        installation,
        conversation,
        userIds,
      });
      if (validation.invalidUserIds.length > 0) {
        throw new ApplicationError(
          'INVALID_CONTROL_ALLOWLIST',
          [
            'Control approvers must be members of the channel.',
            `Invalid: ${validation.invalidUserIds.join(', ')}`,
            validation.reason,
          ]
            .filter(Boolean)
            .join(' '),
        );
      }
    }
    const rows =
      await this.repositories.conversations.replaceChannelControlApprovers({
        appId: input.appId,
        conversationId: conversation.id,
        externalUserIds: userIds,
        updatedAt: input.updatedAt,
      });
    return { userIds: rows.map((row) => row.externalUserId) };
  }

  async isControlApproverAllowed(input: {
    appId: AppId;
    providerId: ChannelProviderId;
    channelJid: string;
    userId: string;
  }): Promise<boolean> {
    const userId = input.userId.trim();
    if (!userId) return false;
    const conversation = await this.findConversationForJid(input);
    if (!conversation) return false;
    const approvers =
      await this.repositories.conversations.listChannelControlApprovers(
        conversation.id,
      );
    return approvers.some((approver) => approver.externalUserId === userId);
  }

  private async requireChannel(input: {
    appId: AppId;
    conversationId: ConversationId;
  }): Promise<{
    conversation: Conversation;
    installation: ChannelInstallation;
  }> {
    const conversation = await this.repositories.conversations.getConversation(
      input.conversationId,
    );
    if (!conversation || conversation.appId !== input.appId) {
      throw new ApplicationError('NOT_FOUND', 'Channel not found');
    }
    const installation =
      await this.repositories.channelInstallations.getChannelInstallation(
        conversation.channelInstallationId,
      );
    if (!installation || installation.appId !== input.appId) {
      throw new ApplicationError('NOT_FOUND', 'Channel installation not found');
    }
    return { conversation, installation };
  }

  private async validateMembership(
    input: ChannelMembershipValidationInput,
  ): Promise<ChannelMembershipValidationResult> {
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
    input: ChannelMembershipValidationInput,
  ): Promise<ChannelMembershipValidationResult> {
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
          ? 'No channel participant records are available.'
          : undefined,
    };
  }

  private async findConversationForJid(input: {
    appId: AppId;
    providerId: ChannelProviderId;
    channelJid: string;
  }): Promise<Conversation | null> {
    const direct = await this.repositories.conversations.getConversation(
      `conversation:${input.channelJid}` as ConversationId,
    );
    if (direct?.appId === input.appId) return direct;
    const candidates = [
      input.channelJid,
      input.channelJid.startsWith(`${input.providerId}:`)
        ? input.channelJid.slice(String(input.providerId).length + 1)
        : undefined,
    ].filter((value): value is string => Boolean(value));
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
