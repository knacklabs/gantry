import { DEFAULT_JOB_RUNTIME_APP_ID, filterJobsByCanonicalAppSession, } from '../jobs/job-access.js';
import { requiredModelCredentialProviders, } from '../model-resolution/required-model-credential-providers.js';
import { buildControlPlaneReadModelFromSettings, } from './control-plane-read-model.js';
import { controlPlaneJobStatus, controlPlaneMemoryStatus, controlPlaneProviderInputs, } from './control-plane-settings-inputs.js';
export function createResolveObserverStatus(input) {
    return (appId) => resolveControlObserverStatus({
        appId,
        settings: {
            ...input.getEffectiveRuntimeSettings(),
            conversations: input.getInternalRuntimeSettings().conversations,
        },
        memoryState: input.getEffectiveMemoryState(),
        conversations: input.conversations,
    });
}
export async function resolveControlObserverStatus(input) {
    const { settings, memoryState } = input;
    if (!settings.observer.enabled) {
        return observerStatus(false, 'disabled', 'Observer is disabled.', memoryState);
    }
    const owner = settings.observer.owner;
    const conversation = owner
        ? settings.conversations[owner.conversation]
        : undefined;
    const providerAccountId = conversation
        ? conversation.providerAccount || conversation.providerConnection || ''
        : '';
    const providerAccount = settings.providerAccounts[providerAccountId];
    if (!owner ||
        !conversation ||
        (conversation.kind !== 'dm' && conversation.kind !== 'direct') ||
        !conversation.controlApprovers.includes(owner.recipient) ||
        !providerAccount ||
        providerAccount.status === 'disabled' ||
        settings.providers[providerAccount.provider]?.enabled !== true) {
        return observerStatus(true, 'configuration_required', 'Observer owner and owner DM must be configured.', memoryState);
    }
    const stored = await input.conversations.getConversationByExternalRef({
        appId: input.appId,
        providerId: providerAccount.provider,
        providerAccountId: providerAccountId,
        externalConversationId: conversation.externalId,
    });
    if (!stored || stored.kind !== 'direct') {
        return unverifiedObserverOwner(memoryState);
    }
    const [participants, approvers] = await Promise.all([
        input.conversations.listParticipantExternalUserIds(stored.id),
        input.conversations.listConversationApprovers(stored.id),
    ]);
    if (!participants.includes(owner.recipient) ||
        !approvers.some((approver) => approver.externalUserId === owner.recipient)) {
        return unverifiedObserverOwner(memoryState);
    }
    const scopedConversationPrefix = `conversation:${providerAccountId}:`;
    const storedConversationId = String(stored.id);
    const conversationJid = storedConversationId.startsWith(scopedConversationPrefix)
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
        return observerStatus(true, 'evidence_accumulating', 'Memory is off; evidence is accumulating, but observer promotion is disabled.', memoryState, resolvedOwner);
    }
    if (!memoryState.dreamingEnabled) {
        return observerStatus(true, 'evidence_accumulating', 'Dreaming is off; evidence is accumulating, but promotion is disabled.', memoryState, resolvedOwner);
    }
    return observerStatus(true, 'active', 'Observer is active.', memoryState, resolvedOwner);
}
function observerStatus(enabled, activation, message, memoryState, owner = null) {
    return {
        enabled,
        activation,
        message,
        dreamingEnabled: memoryState.enabled && memoryState.dreamingEnabled,
        owner,
    };
}
function unverifiedObserverOwner(memoryState) {
    return observerStatus(true, 'configuration_required', 'Observer owner must be a verified member and persisted control approver of the owner DM.', memoryState);
}
/**
 * Build the unified control-plane read model from runtime storage repositories.
 * Shared by the CLI (`gantry next`) and the MCP guided-action preview so both
 * derive the identical next action, including jobs, that the Control API already
 * derives via its injected request context.
 */
export async function buildControlPlaneReadModelFromRepositories(input) {
    const { appId, settings } = input;
    const credentials = await input.modelCredentialsRepository.listModelCredentials({ appId });
    const jobs = await listControlPlaneJobs(input);
    const accessNeedsApprovalCount = await input.pendingAccessRequestsRepository.countPendingAccessRequests({
        appId,
    });
    const activeProviderIds = new Set(credentials
        .filter((credential) => credential.status === 'active')
        .map((credential) => credential.providerId));
    const requiredProviders = requiredModelCredentialProviders(settings);
    return buildControlPlaneReadModelFromSettings({
        settings,
        workspaceKey: appId,
        modelCredentialReady: requiredProviders.every((providerId) => activeProviderIds.has(providerId)),
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
async function listControlPlaneJobs(input) {
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
