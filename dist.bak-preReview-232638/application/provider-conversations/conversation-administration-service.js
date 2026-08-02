import { canonicalConversationThreadId } from '../../domain/conversation/conversation.js';
import { ApplicationError } from '../common/application-error.js';
export class ConversationAdministrationService {
    repositories;
    membershipValidator;
    constructor(repositories, membershipValidator) {
        this.repositories = repositories;
        this.membershipValidator = membershipValidator;
    }
    async getAdminSummary(input) {
        const { conversation } = await this.requireConversation(input);
        const approvers = await this.repositories.conversations.listConversationApprovers(conversation.id);
        return {
            controlAllowlist: {
                userIds: approvers.map((approver) => approver.externalUserId),
            },
        };
    }
    async replaceControlAllowlist(input) {
        const { conversation, providerAccount } = await this.requireConversation(input);
        const userIds = normalizeUserIds(input.userIds);
        const invalidShape = userIds.filter((id) => !isValidExternalUserId(id));
        if (invalidShape.length > 0) {
            throw new ApplicationError('INVALID_REQUEST', `Invalid control approver user ids: ${invalidShape.join(', ')}`);
        }
        if (userIds.length > 0) {
            const validation = await this.validateMembership({
                providerId: providerAccount.providerId,
                providerAccount,
                conversation,
                userIds,
            });
            if (validation.invalidUserIds.length > 0) {
                throw new ApplicationError('INVALID_CONTROL_ALLOWLIST', [
                    'Control approvers must be members of the conversation.',
                    `Invalid: ${validation.invalidUserIds.join(', ')}`,
                    validation.reason,
                ]
                    .filter(Boolean)
                    .join(' '));
            }
        }
        const rows = await this.repositories.conversations.replaceConversationApprovers({
            appId: input.appId,
            conversationId: conversation.id,
            externalUserIds: userIds,
            updatedAt: input.updatedAt,
        });
        return { userIds: rows.map((row) => row.externalUserId) };
    }
    async isControlApproverAllowed(input) {
        const userId = input.userId.trim();
        if (!userId)
            return false;
        const conversation = await this.findConversationForJid(input);
        if (!conversation)
            return false;
        if (conversation.providerAccountId !== input.providerAccountId)
            return false;
        const threadId = canonicalConversationThreadId({
            conversation,
            threadId: input.threadId,
        });
        const install = await this.repositories.providerAccounts.getConversationInstall({
            appId: input.appId,
            agentId: input.agentId,
            conversationId: conversation.id,
            ...(threadId ? { threadId } : {}),
        });
        if (!install || install.status !== 'active')
            return false;
        const approvers = await this.repositories.conversations.listConversationApprovers(conversation.id);
        if (!approvers.some((approver) => approver.externalUserId === userId)) {
            return false;
        }
        const providerAccount = await this.repositories.providerAccounts.getProviderAccount(conversation.providerAccountId);
        if (!providerAccount)
            return false;
        const validation = await this.validateMembership({
            providerId: providerAccount.providerId,
            providerAccount,
            conversation,
            userIds: [userId],
        });
        return validation.validUserIds.includes(userId);
    }
    async requireConversation(input) {
        const conversation = await this.repositories.conversations.getConversation(input.conversationId);
        if (!conversation || conversation.appId !== input.appId) {
            throw new ApplicationError('NOT_FOUND', 'Conversation not found');
        }
        const providerAccount = await this.repositories.providerAccounts.getProviderAccount(conversation.providerAccountId);
        if (!providerAccount || providerAccount.appId !== input.appId) {
            throw new ApplicationError('NOT_FOUND', 'provider account not found');
        }
        return { conversation, providerAccount };
    }
    async validateMembership(input) {
        const providerId = String(input.providerId);
        if (providerId === 'app' ||
            providerId === 'web' ||
            providerId === 'local') {
            return this.validateKnownConversationParticipants(input);
        }
        if (this.membershipValidator) {
            return this.membershipValidator.validateControlApprovers(input);
        }
        return this.validateKnownConversationParticipants(input);
    }
    async validateKnownConversationParticipants(input) {
        const knownMembers = new Set(await this.repositories.conversations.listParticipantExternalUserIds(input.conversation.id));
        return {
            validUserIds: input.userIds.filter((id) => knownMembers.has(id)),
            invalidUserIds: input.userIds.filter((id) => !knownMembers.has(id)),
            reason: knownMembers.size === 0
                ? 'No conversation participant records are available.'
                : undefined,
        };
    }
    async findConversationForJid(input) {
        const direct = await this.repositories.conversations.getConversation(`conversation:${input.conversationJid}`);
        if (direct?.appId === input.appId &&
            direct.providerAccountId === input.providerAccountId &&
            direct.status === 'active') {
            return direct;
        }
        const candidates = conversationExternalRefCandidates({
            providerId: String(input.providerId),
            conversationJid: input.conversationJid,
        });
        for (const candidate of candidates) {
            const conversation = await this.repositories.conversations.getConversationByExternalRef({
                appId: input.appId,
                providerId: input.providerId,
                providerAccountId: input.providerAccountId,
                externalConversationId: candidate,
            });
            if (conversation)
                return conversation;
        }
        return null;
    }
}
function conversationExternalRefCandidates(input) {
    const candidates = new Set();
    const jid = input.conversationJid.trim();
    if (!jid)
        return [];
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
function normalizeUserIds(userIds) {
    return [
        ...new Set(userIds
            .filter((id) => typeof id === 'string')
            .map((id) => id.trim())
            .filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
}
function isValidExternalUserId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value);
}
