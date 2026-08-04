import { logger } from '../../infrastructure/logging/logger.js';
import { stripInternalTagsPreserveWhitespace } from '../../messaging/router.js';
import { isSenderControlAllowed, isSenderAllowed, loadSenderControlAllowlist, loadSenderAllowlist, shouldDropMessage, shouldLogDenied, } from '../../platform/sender-allowlist.js';
import { getPartialMessageDeliveryMetadata, isPartialMessageDeliveryError, } from '../../domain/messages/partial-delivery.js';
import { AmbiguousDurableDeliveryError } from '../../domain/messages/durable-delivery.js';
import { getRuntimeStorage, getRuntimeRepositories, tryAcquireRuntimeAdvisoryLease, } from '../../adapters/storage/postgres/runtime-store.js';
import { EnvRuntimeSecretProvider } from '../../adapters/credentials/env-runtime-secret-provider.js';
import { ConversationAdministrationService } from '../../application/provider-conversations/conversation-administration-service.js';
import { RuntimeSecretConversationMembershipValidator } from '../../channels/conversation-membership-validation.js';
import { asAgentTodoSurface, asMessageReactionSink, asPermissionApprovalSurface, asProgressSink, asRichInteractionSurface, asStreamingSink, asStreamingStateSink, asTypingSink, asUserQuestionSurface, } from './channel-capability-ports.js';
import { listChannelProviders, providerForJid, providerIdForJid, } from '../../channels/provider-registry.js';
import { AsyncTaskQueue } from './async-task-queue.js';
import { createChannelPersistenceHandlers } from './channel-persistence-handlers.js';
import { createAgentTodoRenderer, createRichInteractionRenderer, createUserQuestionResponder, } from './channel-wiring-interactions.js';
import { assertRecoveryDispatchPermit, createRecoveryDispatchPermit, sanitizeDeliveryError, } from './channel-wiring-delivery-guards.js';
import { createConversationOutboundProjection } from './conversation-outbound-projection.js';
import { sanitizeRetryTailForCanonicalDestination } from './runtime-services-destination-hints.js';
import { nowIso } from '../../shared/time/datetime.js';
import { authorizeConversationApprover, resolveControlApproverContext, resolveInputControlApproverContext, } from './channel-wiring-approver.js';
import { createChannelMessageActionRouter } from './channel-message-action-router.js';
import { createChannelProgressSender } from './channel-progress-sender.js';
import { hydrateChannelConversationContext } from './channel-wiring-conversation-context.js';
import { createChannelWiringStreamReset } from './channel-wiring-stream-reset.js';
import { connectProviderAccountChannels, } from '../../channels/provider-account-channel-connect.js';
import { createPermissionApprovalRequester } from '../../channels/permission-approval-requester.js';
import * as routeProviderAccount from './channel-wiring-route-provider-account.js';
import { syncChannelGroups } from './channel-wiring-group-sync.js';
const PROVIDER_INBOUND_LEASE_PREFIX = 'runtime:provider-inbound';
export function createChannelWiring(app, deps = {}) {
    const resolved = {
        appId: 'default',
        providerIds: listChannelProviders(),
        loadSenderAllowlist,
        loadSenderControlAllowlist,
        shouldDropMessage,
        isSenderAllowed,
        isSenderControlAllowed,
        shouldLogDenied,
        logger,
        runtimeSecrets: new EnvRuntimeSecretProvider(),
        ...deps,
    };
    const connectedChannels = [];
    const connectedChannelLeases = [];
    let enqueueRetryTailRecovery;
    let durableOutboundAttemptFactory;
    const messageActionRouter = createChannelMessageActionRouter();
    const persistenceQueue = new AsyncTaskQueue(4, 5_000);
    const ops = () => resolved.opsRepository ?? getRuntimeRepositories();
    const optionalOps = () => {
        try {
            return ops();
        }
        catch (err) {
            resolved.logger.debug({ err }, 'Runtime storage unavailable; skipping outbound message persistence');
            return undefined;
        }
    };
    let currentRuntimeSettings;
    function findBoundChannel(jid, providerAccountId) {
        // prettier-ignore
        return routeProviderAccount.findBoundChannelForProviderAccount(connectedChannels, jid, providerAccountId);
    }
    const findBoundChannelForRequest = (jid, providerAccountId, request) => 
    // prettier-ignore
    routeProviderAccount.findBoundChannelForRequest(app, connectedChannels, jid, providerAccountId, request);
    const streamReset = createChannelWiringStreamReset({
        findBoundChannel,
        asStreamingStateSink,
        asPermissionApprovalSurface,
        asUserQuestionSurface,
    });
    const isControlApproverAllowed = (input) => Promise.resolve(resolveInputControlApproverContext({
        routes: app.getConversationRoutes(),
        ...input,
    })).then((context) => {
        if (!context)
            return false;
        return authorizeConversationApprover({
            ...input,
            logger: resolved.logger,
            lookup: async () => {
                const repos = getRuntimeStorage().repositories;
                return new ConversationAdministrationService({
                    providerAccounts: repos.providerAccounts,
                    conversations: repos.conversations,
                }, new RuntimeSecretConversationMembershipValidator(resolved.runtimeSecrets)).isControlApproverAllowed({
                    appId: resolved.appId,
                    providerId: input.providerId,
                    providerAccountId: context.providerAccountId,
                    agentId: context.agentId,
                    conversationJid: input.conversationJid,
                    threadId: input.threadId,
                    userId: input.userId,
                });
            },
        });
    });
    const requestPermissionApproval = createPermissionApprovalRequester({
        findBoundChannel: (jid, providerAccountId, request) => findBoundChannelForRequest(jid, providerAccountId, request),
        asPermissionApprovalSurface: (channel) => streamReset.asPermissionApprovalSurface(channel),
        interactionLifecycle: { logger: resolved.logger },
    });
    const userQuestionResponder = createUserQuestionResponder({
        findBoundChannel: (jid, request) => findBoundChannelForRequest(jid, undefined, request),
        asUserQuestionSurface: (channel) => streamReset.asUserQuestionSurface(channel),
        interactionLifecycle: { logger: resolved.logger },
    });
    const agentTodoRenderer = createAgentTodoRenderer({
        findBoundChannel,
        asAgentTodoSurface: (channel) => asAgentTodoSurface(channel),
        logger: resolved.logger,
    });
    const richInteractionRenderer = createRichInteractionRenderer({
        findBoundChannel,
        asRichInteractionSurface: (channel) => asRichInteractionSurface(channel),
        sendMessage: (jid, text, options) => sendMessage(jid, text, {
            durability: 'best_effort',
            messageOptions: options,
        }),
        logger: resolved.logger,
    });
    const sendProgressUpdate = createChannelProgressSender({
        findBoundChannel,
        messageActionRouter,
        logger: resolved.logger,
    });
    const channelOpts = {
        ...createChannelPersistenceHandlers({
            app,
            resolved,
            ops,
            persistenceQueue,
            runtimeSettings: () => currentRuntimeSettings,
        }),
        conversationRoutes: () => app.getConversationRoutes(),
        runtimeSettings: () => currentRuntimeSettings,
        runtimeLease: { tryAcquire: tryAcquireRuntimeAdvisoryLease },
        get runtimeSecrets() {
            return resolved.runtimeSecrets;
        },
        isControlApproverAllowed,
        onMessageAction: messageActionRouter.handle,
    };
    async function connectEnabledChannels(runtimeSettings, options) {
        currentRuntimeSettings = runtimeSettings;
        const inboundEnabled = runtimeSettings.runtime.liveTurns.enabled &&
            (options?.providerInbound ?? true);
        for (const provider of resolved.providerIds) {
            if (!provider.isEnabled(runtimeSettings)) {
                resolved.logger.info({ channel: provider.id }, 'Channel disabled in settings.yaml — skipping connect');
                continue;
            }
            await connectProviderAccountChannels({
                provider,
                appId: resolved.appId,
                runtimeSettings,
                channelOpts,
                inboundEnabled,
                connectedChannels,
                connectedChannelLeases,
                inboundLeasePrefix: PROVIDER_INBOUND_LEASE_PREFIX,
                logger: resolved.logger,
            });
        }
    }
    const hasConnectedChannels = () => connectedChannels.length > 0;
    function describeDestinationJid(jid) {
        const provider = providerForJid(jid);
        return {
            ...(provider
                ? { providerId: provider.id, internal: provider.internal === true }
                : { internal: false }),
            runtimeAppId: resolved.appId,
        };
    }
    const hasChannel = (jid, options) => findBoundChannel(jid, options?.providerAccountId) !== undefined;
    function supportsStreaming(jid, options) {
        const channel = findBoundChannel(jid, options?.providerAccountId);
        const provider = providerForJid(jid);
        if (!channel || provider?.canStreamToJid?.(jid) === false)
            return false;
        return asStreamingSink(channel) !== undefined;
    }
    function supportsProgress(jid, options) {
        const channel = findBoundChannel(jid, options?.providerAccountId);
        return channel ? asProgressSink(channel) !== undefined : false;
    }
    async function sendMessage(jid, rawText, options) {
        await sendProviderMessageInternal(jid, rawText, {
            ...options,
            persistence: 'message_row_projection',
        });
    }
    async function sendProviderMessage(jid, rawText, options) {
        assertRecoveryDispatchPermit(options.permit, {
            jid,
            rawText,
            threadId: options.messageOptions?.threadId,
        });
        return sendProviderMessageInternal(jid, rawText, {
            durability: 'best_effort',
            ...options,
            persistence: 'none',
        });
    }
    async function sendProviderMessageInternal(jid, rawText, options) {
        const channel = findBoundChannelForRequest(jid, options.messageOptions?.providerAccountId, {
            threadId: options.messageOptions?.threadId,
            agentId: options.messageOptions?.agentId,
        });
        if (!channel) {
            if (options.throwOnMissing) {
                throw new Error(`No channel for JID: ${jid}`);
            }
            resolved.logger.warn({ jid }, 'No channel owns JID, cannot send message');
            return;
        }
        const projection = createConversationOutboundProjection({
            rawText,
            channelName: channel.name,
            providerId: providerForJid(jid)?.id ?? channel.name,
            conversationJid: jid,
            threadId: options.messageOptions?.threadId,
            providerAccountId: options.messageOptions?.providerAccountId ??
                connectedChannels.find((bound) => bound.channel === channel && bound.channel.ownsJid(jid))?.providerAccountId,
            appId: resolved.appId,
            publishRuntimeEvent: resolved.publishRuntimeEvent,
            logger: resolved.logger,
        });
        if (!projection)
            return;
        const { formatted, provider, messageId, baseMessage, publishEvent: publishConversationOutboundEvent, } = projection;
        let durableAttempt;
        if (options.durability === 'required') {
            if (!durableOutboundAttemptFactory) {
                throw new Error(`Durable outbound delivery is required before sending to ${jid}, but outbound delivery storage is unavailable.`);
            }
            try {
                durableAttempt = await durableOutboundAttemptFactory({
                    appId: resolved.appId,
                    chatJid: jid,
                    threadId: options.messageOptions?.threadId,
                    providerAccountId: baseMessage.providerAccountId,
                    sourceMessageId: messageId,
                    provider,
                    canonicalText: formatted,
                });
            }
            catch (err) {
                throw new Error(`Failed to initialize durable outbound delivery before sending to ${jid}; refusing provider send.`, { cause: err });
            }
        }
        let outboundOps = (() => {
            if (options.persistence !== 'message_row_projection')
                return undefined;
            return optionalOps();
        })();
        try {
            await outboundOps?.storeMessage({
                ...baseMessage,
                delivery_status: 'pending',
            });
        }
        catch (err) {
            resolved.logger.warn({ err, jid }, 'Outbound pending message-row projection persistence failed; continuing with provider send');
            outboundOps = undefined;
        }
        let result;
        try {
            const delivery = options.messageOptions
                ? await channel.sendMessage(jid, formatted, options.messageOptions)
                : await channel.sendMessage(jid, formatted);
            result = delivery;
        }
        catch (err) {
            const partial = isPartialMessageDeliveryError(err);
            const partialMetadata = partial
                ? getPartialMessageDeliveryMetadata(err)
                : undefined;
            const retryTail = partialMetadata?.retryTail;
            const sanitizedRetryTail = partial
                ? sanitizeRetryTailForCanonicalDestination(retryTail, jid)
                : undefined;
            let thrownError = err;
            if (options.durability === 'required' && durableAttempt) {
                try {
                    if (partial) {
                        await durableAttempt.settlePartiallyDelivered({
                            partialAt: nowIso(),
                            error: err instanceof Error
                                ? err.message
                                : 'Outbound provider send was partially delivered.',
                            deliveredParts: partialMetadata?.deliveredParts,
                            totalParts: partialMetadata?.totalParts,
                            retryTail: sanitizedRetryTail,
                        });
                    }
                    else {
                        await durableAttempt.settleFailed({
                            failedAt: nowIso(),
                            error: sanitizeDeliveryError(err, provider),
                        });
                    }
                }
                catch (persistErr) {
                    if (partial) {
                        thrownError = new AmbiguousDurableDeliveryError({
                            provider,
                            conversationJid: jid,
                            cause: persistErr,
                            message: 'Provider send ended in partial visibility but durable retry-tail persistence failed. Delivery may be incomplete and recovery is unavailable.',
                        });
                    }
                    else {
                        thrownError = new Error('Provider send failed and durable failure-state persistence failed; recovery availability is unknown.', {
                            cause: {
                                providerError: err,
                                persistenceError: persistErr,
                            },
                        });
                    }
                }
            }
            else if (partial &&
                sanitizedRetryTail &&
                options.durability === 'required' &&
                enqueueRetryTailRecovery) {
                try {
                    await enqueueRetryTailRecovery({
                        appId: resolved.appId,
                        chatJid: jid,
                        threadId: options.messageOptions?.threadId,
                        providerAccountId: baseMessage.providerAccountId,
                        sourceMessageId: messageId,
                        provider,
                        retryTail: sanitizedRetryTail,
                    });
                }
                catch (enqueueErr) {
                    resolved.logger.error({
                        err: enqueueErr,
                        jid,
                        provider,
                        sourceMessageId: messageId,
                    }, 'Failed to enqueue durable retry-tail recovery item');
                    thrownError = new AmbiguousDurableDeliveryError({
                        provider,
                        conversationJid: jid,
                        cause: enqueueErr,
                        message: 'Provider send ended in partial visibility but retry-tail recovery enqueue failed. Delivery may be incomplete and recovery is unavailable.',
                    });
                }
            }
            try {
                await outboundOps?.storeMessage({
                    ...baseMessage,
                    delivery_status: partial ? 'partially_sent' : 'failed',
                    delivered_at: partial ? nowIso() : undefined,
                    delivery_error: sanitizeDeliveryError(err, provider),
                    delivery_retry_tail: sanitizedRetryTail,
                });
            }
            catch (persistErr) {
                resolved.logger.error({ err: persistErr, jid }, 'Failed to persist outbound delivery failure');
            }
            await publishConversationOutboundEvent({
                deliveryStatus: partial ? 'partially_sent' : 'failed',
                error: sanitizeDeliveryError(err, provider),
            });
            throw thrownError;
        }
        if (options.durability === 'required' && durableAttempt) {
            const ambiguousSentSettlementError = 'Provider send succeeded but durable sent-status persistence failed. Delivery may already be visible and cannot be blindly retried.';
            try {
                await durableAttempt.settleSent({
                    sentAt: nowIso(),
                    providerMessageId: result?.externalMessageId,
                    providerPayload: result,
                });
            }
            catch (err) {
                const partialAt = nowIso();
                try {
                    await durableAttempt.settlePartiallyDelivered({
                        partialAt,
                        error: ambiguousSentSettlementError,
                    });
                }
                catch (partialPersistErr) {
                    resolved.logger.error({
                        err: partialPersistErr,
                        settleSentError: err,
                        jid,
                        provider,
                        sourceMessageId: messageId,
                    }, 'Failed to persist ambiguous durable outbound state after sent settlement failure');
                    throw new AmbiguousDurableDeliveryError({
                        provider,
                        conversationJid: jid,
                        cause: {
                            settleSentError: err,
                            settlePartiallyDeliveredError: partialPersistErr,
                        },
                        message: 'Provider send succeeded but both sent and ambiguous partial durable settlements failed. Delivery may already be visible and cannot be blindly retried.',
                        externalMessageId: result?.externalMessageId,
                        externalMessageIds: result?.externalMessageIds,
                    });
                }
                throw new AmbiguousDurableDeliveryError({
                    provider,
                    conversationJid: jid,
                    cause: err,
                    message: ambiguousSentSettlementError,
                    externalMessageId: result?.externalMessageId,
                    externalMessageIds: result?.externalMessageIds,
                });
            }
        }
        try {
            await outboundOps?.storeMessage({
                ...baseMessage,
                external_message_id: result?.externalMessageId,
                delivery_status: 'sent',
                delivered_at: nowIso(),
            });
        }
        catch (err) {
            const ambiguousError = 'Provider send succeeded but durable sent-status persistence failed. Delivery may already be visible and cannot be blindly retried.';
            resolved.logger.warn({
                err,
                jid,
                provider,
                durability: options.durability,
                externalMessageId: result?.externalMessageId,
                externalMessageIds: result?.externalMessageIds,
                deliveryWarnings: result?.warnings,
            }, options.durability === 'required'
                ? 'Provider send succeeded but outbound sent-status projection failed'
                : 'Provider send succeeded but outbound sent-status persistence failed');
            if (options.durability === 'required') {
                try {
                    await outboundOps?.storeMessage({
                        ...baseMessage,
                        external_message_id: result?.externalMessageId,
                        delivery_status: 'partially_sent',
                        delivered_at: nowIso(),
                        delivery_error: ambiguousError,
                    });
                }
                catch (ambiguousPersistErr) {
                    resolved.logger.error({
                        err: ambiguousPersistErr,
                        jid,
                        provider,
                        sourceMessageId: messageId,
                    }, 'Failed to persist ambiguous durable outbound status after sent-status write failure');
                }
            }
        }
        await publishConversationOutboundEvent({
            deliveryStatus: 'sent',
            externalMessageId: result?.externalMessageId,
        });
        return result;
    }
    function setRetryTailRecoveryEnqueue(enqueue) {
        enqueueRetryTailRecovery = enqueue;
    }
    function setDurableOutboundAttemptFactory(factory) {
        durableOutboundAttemptFactory = factory;
    }
    async function sendStreamingChunk(jid, rawText, options) {
        const channel = findBoundChannel(jid, options?.providerAccountId);
        if (!channel) {
            resolved.logger.warn({ jid }, 'No channel owns JID, cannot stream message');
            return false;
        }
        const provider = providerForJid(jid);
        if (provider?.canStreamToJid?.(jid) === false)
            return false;
        const text = stripInternalTagsPreserveWhitespace(rawText);
        if (!text && !options?.done)
            return false;
        const sink = asStreamingSink(channel);
        if (!sink)
            return false;
        return sink.sendStreamingChunk(jid, text, options);
    }
    async function setTyping(jid, isTyping, opts) {
        const channel = findBoundChannel(jid, opts?.providerAccountId);
        if (!channel)
            return;
        const typingSink = asTypingSink(channel);
        if (!typingSink)
            return;
        await typingSink.setTyping(jid, isTyping);
    }
    async function addReaction(jid, ref, emoji, opts) {
        const channel = findBoundChannel(jid, opts?.providerAccountId);
        if (!channel)
            return;
        const reactionSink = asMessageReactionSink(channel);
        if (!reactionSink)
            return;
        await reactionSink.addReaction(jid, ref, emoji);
    }
    async function disconnectChannels() {
        const drained = await persistenceQueue.waitForIdle(5_000);
        if (!drained) {
            resolved.logger.warn('Timed out waiting for channel persistence queue to drain');
        }
        for (const bound of connectedChannels) {
            await bound.channel.disconnect();
        }
        for (const lease of connectedChannelLeases) {
            await lease.release();
        }
        connectedChannels.length = 0;
        connectedChannelLeases.length = 0;
        userQuestionResponder.clear();
    }
    return {
        getRuntimeAppId: () => resolved.appId,
        setRuntimeSecrets: (provider) => {
            resolved.runtimeSecrets = provider;
        },
        describeDestinationJid,
        connectEnabledChannels,
        hasConnectedChannels,
        hasChannel,
        supportsStreaming,
        supportsProgress,
        sendMessage,
        sendProviderMessage,
        createRecoveryDispatchPermit,
        setRetryTailRecoveryEnqueue,
        setDurableOutboundAttemptFactory,
        setMessageActionHandler: messageActionRouter.set,
        sendStreamingChunk,
        resetStreaming: streamReset.resetStreaming,
        setTyping,
        sendProgressUpdate,
        addReaction,
        syncGroups: (force) => syncChannelGroups(connectedChannels, force),
        requestPermissionApproval,
        cancelPermissionApproval: requestPermissionApproval.cancel,
        requestUserAnswer: userQuestionResponder.requestUserAnswer,
        cancelUserQuestion: userQuestionResponder.cancelUserQuestion,
        renderAgentTodo: agentTodoRenderer,
        renderRichInteraction: richInteractionRenderer,
        hydrateConversationContext: (request) => hydrateChannelConversationContext(request, findBoundChannel, providerIdForJid),
        finalizeAgentTodo: agentTodoRenderer.finalize,
        disconnectChannels,
        isControlApproverAllowed: (input) => {
            const providerId = providerIdForJid(input.conversationJid, '');
            if (!providerId)
                return Promise.resolve(false);
            const context = resolveControlApproverContext({
                ...input,
                routes: app.getConversationRoutes(),
            });
            return context
                ? isControlApproverAllowed({ ...input, ...context, providerId })
                : Promise.resolve(false);
        },
    };
}
