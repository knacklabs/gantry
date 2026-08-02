import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { ProviderAccount, ProviderAccountId, ProviderId } from '../../domain/provider/provider.js';
import type { Conversation, ConversationId } from '../../domain/conversation/conversation.js';
import type { ProviderAccountRepository, ConversationRepository } from '../../domain/ports/repositories.js';
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
    validateControlApprovers(input: ConversationMembershipValidationInput): Promise<ConversationMembershipValidationResult>;
}
export interface ConversationAdminSummary {
    controlAllowlist: {
        userIds: string[];
    };
}
export declare class ConversationAdministrationService {
    private readonly repositories;
    private readonly membershipValidator?;
    constructor(repositories: {
        providerAccounts: ProviderAccountRepository;
        conversations: ConversationRepository;
    }, membershipValidator?: ConversationMembershipValidator | undefined);
    getAdminSummary(input: {
        appId: AppId;
        conversationId: ConversationId;
    }): Promise<ConversationAdminSummary>;
    replaceControlAllowlist(input: {
        appId: AppId;
        conversationId: ConversationId;
        userIds: string[];
        updatedAt: string;
    }): Promise<{
        userIds: string[];
    }>;
    isControlApproverAllowed(input: {
        appId: AppId;
        providerId: ProviderId;
        providerAccountId: ProviderAccountId;
        agentId: AgentId;
        conversationJid: string;
        threadId?: string;
        userId: string;
    }): Promise<boolean>;
    private requireConversation;
    private validateMembership;
    private validateKnownConversationParticipants;
    private findConversationForJid;
}
