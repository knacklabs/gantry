import { decisionForMode } from '../../domain/permission-decision.js';
import { permissionRequestFromPayload, readDurablePermissionFullView, } from './pending-interaction-permission-envelope.js';
import { isAllowedPermissionApproverIdentity, permissionClaimReference, samePermissionClaim, } from './pending-interaction-permission-claim.js';
let backend = null;
export function configurePendingInteractionPermissionCallbacks(next) {
    backend = next;
}
export async function replayPersistedPermissionDecisionForRequest(input) {
    const active = backend;
    if (!active)
        return null;
    const appId = input.appId || 'default';
    try {
        let group = await active.repository.findPendingPermissionPromptByMember({
            appId,
            sourceAgentFolder: input.sourceAgentFolder,
            requestId: input.requestId,
        });
        if (!group)
            return null;
        let claim = group.prompt.claim;
        if (isReviewEachClaim(claim)) {
            const expiration = await expireReviewEachClaim(active, claim);
            group = expiration.group;
            if (!group)
                return null;
            claim = expiredReviewEachMemberClaim(group, input.requestId);
        }
        else if (group.prompt.settlementState === 'review_each_expired') {
            claim = expiredReviewEachMemberClaim(group, input.requestId);
        }
        if (!claim)
            return null;
        if (claim.scope.appId !== appId ||
            claim.scope.sourceAgentFolder !== input.sourceAgentFolder) {
            throw new Error('Persisted permission claim scope does not match request');
        }
        const member = group.members.find((candidate) => candidate.requestId === input.requestId);
        const request = member
            ? permissionRequestFromPayload(member.payload)
            : null;
        if (!request) {
            throw new Error('Persisted permission member request is missing');
        }
        return recoveredPermissionDecision({ request, claim });
    }
    catch (err) {
        active.warn?.({ err, requestId: input.requestId }, 'Failed to replay persisted permission decision');
        throw err;
    }
}
async function expireReviewEachClaim(active, claim) {
    const expired = await active.repository.expirePendingPermissionReviewEach({
        claim: permissionClaimReference(claim),
        now: new Date().toISOString(),
    });
    if (expired) {
        assertExpiredReviewEachGroup(expired, claim);
        return { group: expired, expired: true };
    }
    const current = await active.repository.findPendingPermissionPrompt({
        scope: claim.scope,
        includeTerminalSettlement: true,
    });
    if (current?.prompt.settlementState === 'review_each_expired') {
        assertExpiredReviewEachGroup(current, claim);
        return { group: current, expired: false };
    }
    return { group: current, expired: false };
}
function assertExpiredReviewEachGroup(group, claim) {
    if (group.prompt.settlementState !== 'review_each_expired' ||
        !group.prompt.claim ||
        !samePermissionClaim(group.prompt.claim, permissionClaimReference(claim)) ||
        !isReviewEachClaim(group.prompt.claim)) {
        throw new Error('Expired review-each claim is malformed');
    }
}
function expiredReviewEachMemberClaim(group, requestId) {
    const owner = group.prompt.claim;
    const member = group.members.find((candidate) => candidate.requestId === requestId);
    if (group.prompt.settlementState !== 'review_each_expired' ||
        !isReviewEachClaim(owner) ||
        !member ||
        member.sourceAgentFolder !== group.prompt.sourceAgentFolder) {
        return null;
    }
    return {
        id: `${owner.id}:expired:${requestId}`,
        scope: {
            appId: group.prompt.appId,
            sourceAgentFolder: group.prompt.sourceAgentFolder,
            interactionId: requestId,
        },
        intent: {
            mode: 'cancel',
            approverRef: 'system',
            decidedAt: group.prompt.settledAt ?? group.prompt.updatedAt,
        },
        match: {
            kind: 'individual',
            canonicalId: requestId,
            providerAliases: [
                ...new Set([
                    ...owner.match.providerAliases,
                    ...group.prompt.providerAliases,
                ]),
            ],
        },
    };
}
function isReviewEachClaim(claim) {
    return (claim?.match.kind === 'batch' &&
        claim.intent.mode === 'allow_persistent_rule');
}
export async function findDurablePermissionInteractionByRequestId(input) {
    const active = backend;
    if (!active)
        return null;
    try {
        const group = await active.repository.findPendingPermissionPrompt({
            scope: input.scope,
        });
        if (!group)
            return null;
        const { prompt } = group;
        if (prompt.appId !== input.scope.appId ||
            prompt.sourceAgentFolder !== input.scope.sourceAgentFolder ||
            prompt.interactionId !== input.scope.interactionId) {
            return null;
        }
        const providerAliases = [
            ...new Set([
                ...prompt.providerAliases,
                ...(prompt.claim?.match.providerAliases ?? []),
            ]),
        ];
        if (input.providerAlias && !providerAliases.includes(input.providerAlias)) {
            return null;
        }
        const fullView = readDurablePermissionFullView(prompt.fullView);
        return {
            scope: input.scope,
            requestId: prompt.interactionId,
            batchCallbackId: prompt.matchKind === 'batch' ? prompt.interactionId : null,
            sourceAgentFolder: prompt.sourceAgentFolder,
            targetJid: prompt.envelope.targetJid,
            approvalContextJid: prompt.envelope.approvalContextJid,
            threadId: prompt.envelope.threadId,
            decisionPolicy: prompt.envelope.decisionPolicy,
            decisionOptions: prompt.envelope.renderedDecisionOptions,
            externalPromptMessageId: prompt.externalPromptMessageId,
            externalPromptProvider: prompt.externalPromptProvider,
            externalPromptConversationId: prompt.externalPromptConversationId,
            externalPromptThreadId: prompt.externalPromptThreadId,
            providerAliases,
            request: prompt.envelope.renderedRequest,
            ...(prompt.settlementState !== 'review_each_expired' && prompt.claim
                ? { claim: prompt.claim }
                : {}),
            ...(fullView ? { fullView } : {}),
        };
    }
    catch (err) {
        active.warn?.({ err, scope: input.scope }, 'Failed to find durable permission interaction');
        return null;
    }
}
export async function claimPermissionInteractionCallback(input) {
    const active = backend;
    if (!active ||
        !isAllowedPermissionApproverIdentity(input.mode, input.approverRef)) {
        return { status: 'retryable' };
    }
    const claim = input.recoveredClaim ??
        {
            id: input.claimId ?? globalThis.crypto.randomUUID(),
            scope: input.scope,
            intent: {
                mode: input.mode,
                approverRef: input.approverRef,
                decidedAt: input.claimedAt ?? new Date().toISOString(),
            },
            match: {
                kind: input.matchKind,
                canonicalId: input.scope.interactionId,
                providerAliases: input.providerAlias ? [input.providerAlias] : [],
            },
        };
    if (claim.scope.appId !== input.scope.appId ||
        claim.scope.sourceAgentFolder !== input.scope.sourceAgentFolder ||
        claim.scope.interactionId !== input.scope.interactionId ||
        claim.match.canonicalId !== input.scope.interactionId ||
        claim.match.kind !== input.matchKind) {
        return { status: 'retryable' };
    }
    try {
        if (input.recoveredClaim) {
            if (input.expireReviewEach && isReviewEachClaim(claim)) {
                const expiration = await expireReviewEachClaim(active, claim);
                if (!expiration.expired || !expiration.group) {
                    return { status: 'already_decided' };
                }
                const firstRequestId = expiration.group.members[0]?.requestId;
                const persistedClaim = firstRequestId
                    ? expiredReviewEachMemberClaim(expiration.group, firstRequestId)
                    : null;
                if (!persistedClaim)
                    return { status: 'retryable' };
                return {
                    status: 'claimed',
                    claim: permissionClaimReference(claim),
                    persistedClaim,
                };
            }
            return {
                status: 'claimed',
                claim: permissionClaimReference(claim),
                persistedClaim: claim,
            };
        }
        const claimed = await active.repository.claimPendingPermissionCallback({
            claim,
        });
        if (claimed) {
            const persistedClaim = claimed.prompt.claim ?? claim;
            if (input.expireReviewEach && isReviewEachClaim(persistedClaim)) {
                const expiration = await expireReviewEachClaim(active, persistedClaim);
                if (!expiration.expired || !expiration.group) {
                    return { status: 'already_decided' };
                }
                const firstRequestId = expiration.group.members[0]?.requestId;
                const expiredClaim = firstRequestId
                    ? expiredReviewEachMemberClaim(expiration.group, firstRequestId)
                    : null;
                if (!expiredClaim)
                    return { status: 'retryable' };
                return {
                    status: 'claimed',
                    claim: permissionClaimReference(persistedClaim),
                    persistedClaim: expiredClaim,
                };
            }
            return {
                status: 'claimed',
                claim: permissionClaimReference(persistedClaim),
                persistedClaim,
            };
        }
        const current = await active.repository.findPendingPermissionPrompt({
            scope: input.scope,
            includeTerminalSettlement: true,
        });
        if (!current) {
            return input.mode === 'cancel' && input.approverRef === 'system'
                ? { status: 'already_decided', ownerless: true }
                : { status: 'already_decided' };
        }
        return current.prompt.claim || current.prompt.settlementState !== 'open'
            ? { status: 'already_decided' }
            : { status: 'retryable' };
    }
    catch (err) {
        active.warn?.({ err, scope: input.scope }, 'Failed to claim durable permission callback');
        return { status: 'retryable' };
    }
}
export async function releasePermissionInteractionCallback(input) {
    const active = backend;
    if (!active)
        return false;
    try {
        return await active.repository.releasePendingPermissionCallback(input);
    }
    catch (err) {
        active.warn?.({ err, claim: input.claim }, 'Failed to release durable permission callback claim');
        return false;
    }
}
export async function settlePermissionInteractionCallback(input) {
    const active = backend;
    if (!active)
        return false;
    try {
        return await active.repository.settlePendingPermissionCallback(input);
    }
    catch (err) {
        active.warn?.({ err, claim: input.claim }, 'Failed to settle durable permission callback claim');
        return false;
    }
}
export async function resolveDurablePermissionInteractionByRequestId(input) {
    const active = backend;
    if (!active)
        return false;
    let applicationStarted = false;
    let authorityApplied = false;
    let reviewEachExpired = false;
    try {
        let group = await active.repository.findPendingPermissionPrompt({
            scope: input.claim.scope,
        });
        if (!group)
            return false;
        const promptClaim = group.prompt.claim;
        if (isReviewEachClaim(promptClaim)) {
            const expiration = await expireReviewEachClaim(active, promptClaim);
            group = expiration.group;
            if (!group)
                return false;
        }
        reviewEachExpired = group.prompt.settlementState === 'review_each_expired';
        if (!reviewEachExpired &&
            (!group.prompt.claim ||
                !samePermissionClaim(group.prompt.claim, input.claim))) {
            return false;
        }
        if (!reviewEachExpired &&
            group.prompt.matchKind === 'individual' &&
            group.members.length !== 1) {
            await releasePermissionInteractionCallback({ claim: input.claim });
            return false;
        }
        for (const member of group.members) {
            if (!member.sourceAgentFolder ||
                member.sourceAgentFolder !== input.claim.scope.sourceAgentFolder ||
                !member.requestId) {
                if (!reviewEachExpired) {
                    await releasePermissionInteractionCallback({ claim: input.claim });
                }
                return false;
            }
        }
        for (const member of group.members) {
            const requestId = member.requestId;
            const sourceAgentFolder = member.sourceAgentFolder;
            const request = permissionRequestFromPayload(member.payload);
            const rowClaim = reviewEachExpired
                ? expiredReviewEachMemberClaim(group, requestId)
                : group.prompt.claim;
            if (!request || !rowClaim)
                return false;
            const decision = recoveredPermissionDecision({
                request,
                claim: rowClaim,
                reason: input.reason,
            });
            const decisionClaim = decision.permissionCallbackClaim;
            try {
                applicationStarted = true;
                const applied = await active.applyDecision({
                    request,
                    sourceAgentFolder,
                    decision,
                    appId: input.claim.scope.appId,
                    runId: member.runId,
                    runLeaseToken: member.runLeaseToken,
                    runLeaseFencingVersion: member.runLeaseFencingVersion,
                    toolName: request.toolName,
                    requestId,
                });
                if (!applied) {
                    if (!authorityApplied && !reviewEachExpired) {
                        await releasePermissionInteractionCallback({ claim: input.claim });
                    }
                    return false;
                }
                authorityApplied = true;
                const resolutionInput = {
                    kind: 'permission',
                    sourceAgentFolder,
                    requestId,
                    appId: input.claim.scope.appId,
                    runId: member.runId,
                    status: decision.mode === 'cancel' ? 'cancelled' : 'resolved',
                    resolution: {
                        approved: decision.approved,
                        mode: decision.mode,
                        reason: decision.reason ?? input.reason ?? null,
                        updatedPermissions: decision.updatedPermissions ?? null,
                        decisionClassification: decision.decisionClassification ?? null,
                    },
                    approverRef: decision.decidedBy ?? rowClaim.intent.approverRef,
                    permissionCallbackClaim: decisionClaim,
                };
                let resolutionOutcome = await resolvePermissionInteraction(active, resolutionInput);
                if (resolutionOutcome === 'retryable_error') {
                    resolutionOutcome = await resolvePermissionInteraction(active, resolutionInput);
                }
                if (resolutionOutcome !== 'resolved')
                    return false;
            }
            catch (err) {
                active.warn?.({ err, claim: input.claim, requestId }, 'Failed to settle durable permission interaction');
                return false;
            }
        }
        return true;
    }
    catch (err) {
        active.warn?.({ err, claim: input.claim }, 'Failed to resolve durable permission interaction');
        if (!applicationStarted && !reviewEachExpired) {
            await releasePermissionInteractionCallback({ claim: input.claim });
        }
        return false;
    }
}
async function resolvePermissionInteraction(active, input) {
    if (active.resolveOutcome)
        return active.resolveOutcome(input);
    return (await active.resolve(input)) ? 'resolved' : 'rejected';
}
function recoveredPermissionDecision(input) {
    const decision = decisionForMode(input.request, input.claim.intent.mode, input.claim.intent.approverRef);
    return {
        ...decision,
        permissionCallbackClaim: permissionClaimReference(input.claim),
    };
}
