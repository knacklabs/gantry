import { ApplicationError } from '../common/application-error.js';
import { sanitizeRetryTailProviderPayload } from '../../domain/messages/retry-tail-provider-payload.js';
import { OutboundDeliveryIdempotencyConflictError } from '../../domain/outbound-delivery/outbound-delivery.js';
const DEFAULT_MAX_SEGMENTS = 64;
const DEFAULT_MAX_SEGMENT_CHARS = 8_000;
const DEFAULT_MAX_FINAL_TEXT_CHARS = 64_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const DEFAULT_RETRY_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
export class OutboundDeliveryService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async enqueue(input) {
        const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
        const profile = this.deps.profiles.resolve(input.profileId);
        if (!profile) {
            throw new ApplicationError('INVALID_REQUEST', `Unknown outbound delivery profile: ${input.profileId}`);
        }
        const plan = await profile.plan({
            appId: input.appId,
            conversationId: input.conversationId,
            threadId: input.threadId,
            profileId: input.profileId,
            text: input.text,
            metadata: input.metadata,
        });
        const parts = validatePlanParts(plan, input.maxSegments ?? DEFAULT_MAX_SEGMENTS, input.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS);
        const now = this.deps.now();
        const initialClaimToken = input.initialClaim
            ? normalizeInitialClaimToken(input.initialClaim.claimToken, this.deps)
            : undefined;
        const initialClaimExpiresAt = input.initialClaim
            ? (input.initialClaim.claimExpiresAt ?? now)
            : undefined;
        const deliveryId = (input.deliveryId ??
            `delivery:${this.deps.createId()}`);
        const canonicalFinalText = normalizeFinalText(plan, parts, input.maxFinalTextChars ?? DEFAULT_MAX_FINAL_TEXT_CHARS);
        const idempotencyFingerprint = computeIdempotencyFingerprint({
            appId: input.appId,
            conversationId: input.conversationId,
            threadId: input.threadId,
            profileId: input.profileId,
            canonicalFinalText,
            parts,
        }, this.deps.hashSha256Hex);
        const delivery = {
            id: deliveryId,
            appId: input.appId,
            conversationId: input.conversationId,
            threadId: input.threadId,
            agentId: input.agentId,
            runId: input.runId,
            profileId: input.profileId,
            idempotencyKey,
            idempotencyFingerprint,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
        };
        const items = parts.map((part, index) => ({
            id: `delivery-item:${this.deps.createId()}`,
            deliveryId,
            ordinal: index,
            canonicalText: part.canonicalText,
            providerPayload: part.providerPayload,
            status: initialClaimToken ? 'claimed' : 'pending',
            attemptCount: initialClaimToken ? 1 : 0,
            claimToken: initialClaimToken,
            claimExpiresAt: initialClaimExpiresAt,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
        }));
        try {
            const enqueueResult = await this.deps.repository.enqueueDelivery({
                delivery,
                finalAnswer: {
                    deliveryId,
                    canonicalText: canonicalFinalText,
                    segmentCount: items.length,
                    createdAt: now,
                    updatedAt: now,
                },
                items,
            });
            return {
                ...enqueueResult,
                claimedItems: enqueueResult.created && initialClaimToken
                    ? items.map((item) => ({
                        itemId: item.id,
                        claimToken: initialClaimToken,
                    }))
                    : undefined,
                claimedItem: enqueueResult.created && initialClaimToken && items[0]
                    ? {
                        itemId: items[0].id,
                        claimToken: initialClaimToken,
                    }
                    : undefined,
            };
        }
        catch (err) {
            if (err instanceof OutboundDeliveryIdempotencyConflictError) {
                throw new ApplicationError('CONFLICT', `Idempotency key ${idempotencyKey} was already used for a different outbound payload.`, { cause: err });
            }
            throw err;
        }
    }
    async claimPending(input) {
        return this.deps.repository.claimDueDeliveryItems({
            appId: input.appId,
            profileId: input.profileId,
            now: input.now ?? this.deps.now(),
            claimerId: input.claimerId,
            leaseMs: input.leaseMs ?? 15_000,
            limit: input.limit ?? 20,
        });
    }
    async claimPendingAcrossApps(input) {
        return this.deps.repository.claimDueDeliveryItems({
            profileId: input.profileId,
            now: input.now ?? this.deps.now(),
            claimerId: input.claimerId,
            leaseMs: input.leaseMs ?? 15_000,
            limit: input.limit ?? 20,
        });
    }
    async resolveDestination(input) {
        return this.deps.repository.resolveDeliveryDestination(input);
    }
    async settleSent(input) {
        const sentAt = input.sentAt ?? this.deps.now();
        const providerPayload = sanitizeRetryTailProviderPayload(input.providerPayload);
        const receipt = {
            id: (input.receiptId ??
                `delivery-receipt:${this.deps.createId()}`),
            deliveryId: input.deliveryId,
            itemId: input.itemId,
            idempotencyKey: input.receiptIdempotencyKey.trim(),
            providerMessageId: input.providerMessageId,
            providerPayload,
            sentAt,
            createdAt: sentAt,
        };
        return this.deps.repository.markDeliveryItemSent({
            deliveryId: input.deliveryId,
            itemId: input.itemId,
            claimToken: input.claimToken,
            receipt,
        });
    }
    async settleFailed(input) {
        const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS));
        const retryBaseDelayMs = Math.max(1, Math.floor(input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS));
        const retryMaxDelayMs = Math.max(retryBaseDelayMs, Math.floor(input.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS));
        return this.deps.repository.markDeliveryItemFailed({
            deliveryId: input.deliveryId,
            itemId: input.itemId,
            claimToken: input.claimToken,
            error: input.error,
            failedAt: input.failedAt ?? this.deps.now(),
            maxAttempts,
            retryBaseDelayMs,
            retryMaxDelayMs,
        });
    }
    async settlePartiallyDelivered(input) {
        const providerPayload = sanitizeRetryTailProviderPayload(input.retryTail?.providerPayload);
        return this.deps.repository.markDeliveryItemPartiallyDelivered({
            deliveryId: input.deliveryId,
            itemId: input.itemId,
            claimToken: input.claimToken,
            error: input.error,
            partialAt: input.partialAt ?? this.deps.now(),
            deliveredParts: input.deliveredParts,
            totalParts: input.totalParts,
            retryTail: input.retryTail
                ? {
                    canonicalText: input.retryTail.canonicalText,
                    ...(providerPayload !== undefined ? { providerPayload } : {}),
                }
                : undefined,
        });
    }
}
function normalizeInitialClaimToken(token, deps) {
    const normalized = token?.trim();
    return normalized || `claim:${deps.createId()}`;
}
function normalizeFinalText(plan, parts, maxFinalTextChars) {
    const fromPlan = typeof plan.canonicalFinalText === 'string'
        ? normalizeText(plan.canonicalFinalText)
        : '';
    const canonicalText = fromPlan || parts.map((part) => part.canonicalText).join('');
    if (canonicalText.length > maxFinalTextChars) {
        throw new ApplicationError('INVALID_REQUEST', `Outbound delivery canonical final text exceeded ${maxFinalTextChars} characters.`);
    }
    return canonicalText;
}
function validatePlanParts(plan, maxSegments, maxSegmentChars) {
    const parts = Array.isArray(plan.parts) ? plan.parts : [];
    if (parts.length === 0) {
        throw new ApplicationError('INVALID_REQUEST', 'Outbound delivery plan must include at least one segment.');
    }
    if (parts.length > maxSegments) {
        throw new ApplicationError('INVALID_REQUEST', `Outbound delivery plan exceeded max segment count (${maxSegments}).`);
    }
    return parts.map((part, index) => {
        const canonicalText = normalizeText(part?.canonicalText ?? '');
        if (!canonicalText.trim()) {
            throw new ApplicationError('INVALID_REQUEST', `Outbound delivery segment ${index} is empty.`);
        }
        if (canonicalText.length > maxSegmentChars) {
            throw new ApplicationError('INVALID_REQUEST', `Outbound delivery segment ${index} exceeded ${maxSegmentChars} characters.`);
        }
        return {
            canonicalText,
            providerPayload: sanitizeRetryTailProviderPayload(part.providerPayload),
        };
    });
}
function normalizeText(value) {
    return value.replace(/\r\n/g, '\n');
}
function validateIdempotencyKey(raw) {
    const key = raw.trim();
    if (!key) {
        throw new ApplicationError('INVALID_REQUEST', 'Outbound delivery idempotency key must not be empty.');
    }
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new ApplicationError('INVALID_REQUEST', `Outbound delivery idempotency key exceeded ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
    }
    return key;
}
function computeIdempotencyFingerprint(input, hashSha256Hex) {
    const payload = JSON.stringify({
        appId: input.appId,
        conversationId: input.conversationId,
        threadId: input.threadId ?? null,
        profileId: input.profileId,
        canonicalFinalText: input.canonicalFinalText,
        segments: input.parts.map((part, index) => ({
            ordinal: index,
            canonicalText: part.canonicalText,
            providerPayload: stableJson(part.providerPayload ?? null),
        })),
    });
    return `sha256:${hashSha256Hex(payload)}`;
}
function stableJson(value) {
    if (Array.isArray(value))
        return value.map(stableJson);
    if (!value || typeof value !== 'object')
        return value;
    const entries = Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, val]) => [key, stableJson(val)]);
    return Object.fromEntries(entries);
}
