import { DEFAULT_TRIGGER, MESSAGE_FETCH_PAGE_SIZE, TIMEZONE, getCredentialBrokerRuntimeConfig, getDeploymentMode, getRuntimeSettingsForConfig, } from '../../config/index.js';
import { agentIdForFolder } from '../../config/settings/desired-state-service-helpers.js';
import { createAgentToolRuleSettingsMirror, } from '../../config/settings/agent-tool-rule-settings-mirror.js';
import { encodeGroupMessageCursor, toGroupMessageCursor, } from '../../shared/message-cursor.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { writeGroupsSnapshot } from '../../runtime/agent-spawn.js';
import { startIpcWatcher } from '../../runtime/ipc.js';
import { computeHostCapacityPlan } from '../../shared/host-capacity.js';
import { recoverPendingMessages, } from '../../runtime/message-loop.js';
// prettier-ignore
import { markRoleHasNoJobExecution, requestSchedulerSync, startSchedulerLoop } from '../../jobs/scheduler.js';
import { registerWorkerInstance } from '../../jobs/worker-identity.js';
import { createHash, randomUUID } from 'node:crypto';
import { collectRuntimeSessionMemory } from './runtime-app.js';
import { OutboundDeliveryService } from '../../application/outbound-delivery/outbound-delivery-service.js';
import { getPartialMessageDeliveryMetadata, isPartialMessageDeliveryError, } from '../../domain/messages/partial-delivery.js';
import { isAmbiguousDurableDeliveryError } from '../../domain/messages/durable-delivery.js';
import { startOutboundDeliveryRecoveryLoop } from '../../jobs/outbound-delivery-recovery.js';
import { setObserverDigestGateway } from '../../jobs/system-jobs.js';
// prettier-ignore
import { closeBrowser, ensureBrowserReady, getBrowserStatus, } from '../../runtime/browser-capability.js';
import { LIVE_SEND_PROFILE_ID, RETRY_TAIL_PROFILE_ID, canonicalThreadIdFor, normalizeDestinationHintAgainstCanonical, resolveDurableOutboundTarget, sanitizeRetryTailForCanonicalDestination, sanitizeRetryTailProviderPayloadDestinationMetadata, } from './runtime-services-destination-hints.js';
import { splitLiveSendProfileText } from './runtime-services-live-send-segmentation.js';
import { createDurableOutboundAttempt } from './runtime-services-durable-outbound-attempt.js';
import { resolveConversationRoute } from './runtime-app-routes.js';
import { handleActiveNewSessionCommand } from './runtime-services-active-new.js';
import { queueActiveCompactionForRuntime, sendActiveControlReceipt, sendActiveCompactionQueuedReceipt, } from './runtime-services-active-compact.js';
import { registerRuntimeLiveStopMessageAction } from './runtime-live-stop-message-action.js';
import { nowIso, nowMs, toIso } from '../../shared/time/datetime.js';
import { LiveTurnAuthority } from '../../runtime/live-turn-authority.js';
import { configurePendingInteractionPermissionPersistence } from '../../application/interactions/pending-interaction-durability.js';
import { liveTurnScopeForQueue } from './live-recovery-coordinator.js';
// prettier-ignore
import { buildLiveAdmissionProcessor, startLiveExecutionServices } from './live-execution.js';
import { buildLiveTurnBrowserFinalizer } from './live-turn-browser-finalizer.js';
import { startWaitingStatusMonitor } from './live-execution-waiting-status.js';
import { buildLiveTurnRecoveryCapabilityGate } from './live-turn-recovery-capability-gate.js';
import { recoverStaleAsyncCommandTasks, startAsyncTaskRecoveryLoop, } from './runtime-services-async-task-recovery.js';
import { wireInlineAgentLoopTools } from './inline-agent-loop-tools.js';
import { createGroupSnapshotSync } from './runtime-services-group-snapshot-sync.js';
export { stopAsyncTaskRecoveryLoop } from './runtime-services-async-task-recovery.js';
function makeDefaultDeps() {
    return {
        startSchedulerLoop,
        startIpcWatcher,
        writeGroupsSnapshot,
        recoverPendingMessages,
        getDeploymentMode,
        logger,
        collectSessionMemory: collectRuntimeSessionMemory,
        startOutboundDeliveryRecoveryLoop,
        callBrowserTool: undefined,
        publishRuntimeEvent: undefined,
        subscribeRuntimeEvents: undefined,
        publishBrowserJobActivity: undefined,
        closeBrowserToolBackends: undefined,
        exit: (code) => process.exit(code),
    };
}
let activeLiveTurnRecoveryLoop;
let activeLiveTurnAuthority;
let activeLiveAdmissionLoop;
let activeWaitingStatusMonitor;
let activeLiveExecutionServices;
export function getOldestWaitingLiveAdmissionSeconds() {
    return activeWaitingStatusMonitor?.oldestWaitingSeconds() ?? 0;
}
export function stopLiveTurnRecoveryLoop() {
    if (activeLiveExecutionServices) {
        activeLiveExecutionServices.stopRecovery();
        activeLiveExecutionServices = undefined;
        return;
    }
    activeLiveTurnRecoveryLoop?.stop();
    activeLiveTurnRecoveryLoop = undefined;
}
export async function stopLiveAdmissionLoop(timeoutMs) {
    const loop = activeLiveAdmissionLoop;
    activeLiveAdmissionLoop = undefined;
    await loop?.stop({ drainDeadlineMs: timeoutMs });
}
export function beginDrainingLiveTurnAdmission() {
    activeLiveTurnAuthority?.beginDraining();
}
export async function shutdownLiveTurnAuthority() {
    const authority = activeLiveTurnAuthority;
    activeLiveTurnAuthority = undefined;
    await authority?.shutdown();
}
export async function startRuntimeServices(options, deps) {
    const { app, channelWiring } = options;
    const liveTurnsEnabled = options.liveTurnsEnabled ?? true;
    const liveExecution = options.liveExecution ?? true;
    const jobExecution = options.jobExecution ?? true;
    const processRole = options.processRole;
    const resolved = {
        ...makeDefaultDeps(),
        ...deps,
        runnerSandboxProvider: app.runnerSandboxProvider,
    };
    const workerCoordination = resolved.getWorkerCoordinationRepository?.();
    const liveTurns = resolved.getLiveTurnRepository?.();
    const liveTurnLeaseDeps = liveTurnsEnabled && liveExecution && workerCoordination && liveTurns
        ? {
            liveTurns,
            coordination: workerCoordination,
            workerInstanceId: await registerWorkerInstance(workerCoordination, {
                warn: (context, message) => resolved.logger.warn(context, message),
                processRole,
            }),
        }
        : undefined;
    const liveTurnAuthority = liveTurnLeaseDeps
        ? new LiveTurnAuthority({
            leaseDeps: liveTurnLeaseDeps,
            slotCapacity: () => app.queue.getPolicy().maxMessageRuns,
            hostSlotCapacity: () => computeHostCapacityPlan({
                queue: app.queue.getPolicy(),
                processRole,
            }).interactiveCapacity,
            hostBudgetCapacity: () => computeHostCapacityPlan({
                queue: app.queue.getPolicy(),
                processRole,
            }).budget,
            commandWakeupSource: resolved.getLiveTurnCommandWakeupSource?.(),
            warn: (context, message) => resolved.logger.warn(context, message),
        })
        : undefined;
    activeLiveTurnAuthority = liveTurnAuthority;
    if (liveTurnsEnabled && !liveTurnAuthority) {
        resolved.logger.warn('Live-turn admission is enabled, but durable live-turn repositories are unavailable; live admission will stay disabled for this role');
    }
    const { isEligibleToRecoverLiveTurn, alertNoEligibleLiveTurnRecoverer } = buildLiveTurnRecoveryCapabilityGate({
        app,
        workerCoordination,
        liveTurnLeaseDeps,
        getDeploymentMode: resolved.getDeploymentMode,
        getSkillRepository: resolved.getSkillRepository,
        getRuntimeDependencyRepository: resolved.getRuntimeDependencyRepository,
        agentIdForFolder,
        publishRuntimeEvent: resolved.publishRuntimeEvent,
        nowMs,
        warn: (context, message) => resolved.logger.warn(context, message),
    });
    const syncGroupSnapshots = createGroupSnapshotSync(app, resolved);
    const inlineInteractions = wireInlineAgentLoopTools({
        ...resolved,
        app,
        channelWiring,
        interactionsEnabled: liveTurnsEnabled && liveExecution,
        getAgentAccessPreset: (folder) => getRuntimeSettingsForConfig().agents?.[folder]?.accessPreset === 'locked'
            ? 'locked'
            : 'full',
        getPermissionRuntimeSettings: getRuntimeSettingsForConfig,
        getAgentRepository: resolved.getAgentRepository,
        getMcpServerRepository: resolved.getMcpServerRepository,
        publishRuntimeEvent: resolved.publishRuntimeEvent,
        warn: (context, message) => resolved.logger.warn(context, message),
    });
    const asyncTaskRecoveryDeps = {
        ...resolved,
        conversationRoutes: () => app.getConversationRoutes(),
    };
    await recoverStaleAsyncCommandTasks(String(channelWiring.getRuntimeAppId()), asyncTaskRecoveryDeps);
    startAsyncTaskRecoveryLoop(String(channelWiring.getRuntimeAppId()), asyncTaskRecoveryDeps);
    const onSchedulerChanged = (jobId) => requestSchedulerSync(jobId);
    const schedulerMessageOptions = (jid, options) => {
        const providerAccountId = options?.providerAccountId ??
            resolveConversationRoute(app.getConversationRoutes(), jid, options?.threadId)?.providerAccountId;
        if (!providerAccountId)
            return options;
        return { ...options, providerAccountId };
    };
    const startScheduler = () => resolved.startSchedulerLoop({
        processRole,
        conversationRoutes: () => app.getConversationRoutes(),
        queue: app.queue,
        onProcess: (groupJid, proc, runHandle, workspaceFolder, stopAliasJids) => app.queue.registerProcess(groupJid, proc, runHandle, workspaceFolder, stopAliasJids),
        sendMessage: (jid, rawText, options) => {
            const messageOptions = schedulerMessageOptions(jid, options);
            return channelWiring.sendMessage(jid, rawText, {
                durability: 'required',
                throwOnMissing: true,
                ...(messageOptions ? { messageOptions } : {}),
            });
        },
        sendStreamingChunk: channelWiring.sendStreamingChunk,
        resetStreaming: channelWiring.resetStreaming,
        onSchedulerChanged,
        opsRepository: resolved.opsRepository,
        collectSessionMemory: resolved.collectSessionMemory,
        getCredentialBroker: resolved.getCredentialBroker ??
            (typeof app.getCredentialBroker === 'function'
                ? () => app.getCredentialBroker()
                : undefined),
        getSkillRepository: resolved.getSkillRepository,
        getMcpServerRepository: resolved.getMcpServerRepository,
        getCapabilitySecretRepository: resolved.getCapabilitySecretRepository,
        getMcpHostnameLookup: () => resolved.mcpHostnameLookup,
        getMcpDnsValidationCache: resolved.getMcpDnsValidationCache,
        getSkillArtifactStore: resolved.getSkillArtifactStore,
        getToolRepository: resolved.getToolRepository,
        getAsyncTaskRepository: resolved.getAsyncTaskRepository,
        getBrowserStatus,
        openBrowserSession: (profileName) => ensureBrowserReady({ profileName }),
        executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
        executionAdapters: resolved.executionAdapters ?? app.executionAdapters,
        runnerSandboxProvider: resolved.runnerSandboxProvider ?? app.runnerSandboxProvider,
        closeBrowserSession: closeBrowser,
        closeBrowserToolBackends: resolved.closeBrowserToolBackends,
    });
    const mirrorAgentToolRulesToSettings = createAgentToolRuleSettingsMirror({
        opsRepository: resolved.opsRepository,
        repositories: resolved.settingsRepositories,
        reloadRuntimeState: () => app.loadState(),
    });
    configurePendingInteractionPermissionPersistence({
        opsRepository: resolved.opsRepository,
        getToolRepository: resolved.getToolRepository,
        getPermissionRepository: resolved.getPermissionRepository,
        mirrorAgentToolRulesToSettings,
        onSchedulerChanged,
        getSkillRepository: resolved.getSkillRepository,
        getMcpServerRepository: resolved.getMcpServerRepository,
        getCapabilitySecretRepository: resolved.getCapabilitySecretRepository,
        getCredentialBroker: app.getCredentialBroker,
        getBrowserStatus,
        publishRuntimeEvent: resolved.publishRuntimeEvent,
    });
    const startIpcWatcher = () => resolved.startIpcWatcher({
        sendMessage: (jid, text, options) => channelWiring.sendMessage(jid, text, {
            durability: 'required',
            throwOnMissing: true,
            ...(options ? { messageOptions: options } : {}),
        }),
        conversationRoutes: () => app.getConversationRoutes(),
        registerGroup: app.registerGroup,
        syncGroups: (force) => channelWiring.syncGroups(force),
        getAvailableGroups: app.getAvailableGroups,
        writeGroupsSnapshot: (folder, availableGroups, registeredJids) => resolved.writeGroupsSnapshot(folder, availableGroups, registeredJids),
        onSchedulerChanged,
        opsRepository: resolved.opsRepository,
        getToolRepository: resolved.getToolRepository,
        getAgentRepository: resolved.getAgentRepository,
        getSkillRepository: resolved.getSkillRepository,
        getAsyncTaskRepository: resolved.getAsyncTaskRepository,
        getMcpServerRepository: resolved.getMcpServerRepository,
        getCapabilitySecretRepository: resolved.getCapabilitySecretRepository,
        getSkillArtifactStore: resolved.getSkillArtifactStore,
        getMcpDnsValidationCache: resolved.getMcpDnsValidationCache,
        executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
        executionAdapters: resolved.executionAdapters ?? app.executionAdapters,
        runnerSandboxProvider: resolved.runnerSandboxProvider,
        runApprovedCommand: resolved.runApprovedCommand,
        getPermissionRepository: resolved.getPermissionRepository,
        getPermissionPromotionRepository: resolved.getPermissionPromotionRepository,
        getPermissionDecisionMemoryRepository: resolved.getPermissionDecisionMemoryRepository,
        publishRuntimeEvent: resolved.publishRuntimeEvent,
        getPermissionRuntimeSettings: getRuntimeSettingsForConfig,
        getPermissionMessageRepository: () => resolved.opsRepository,
        subscribeRuntimeEvents: resolved.subscribeRuntimeEvents,
        getEgressSettings: () => getRuntimeSettingsForConfig().permissions.egress,
        mirrorAgentToolRulesToSettings,
        reloadRuntimeState: () => app.loadState(),
        getCredentialBroker: app.getCredentialBroker,
        getCredentialBrokerProfile: () => getCredentialBrokerRuntimeConfig().mode,
        callBrowserTool: resolved.callBrowserTool,
        publishBrowserJobActivity: resolved.publishBrowserJobActivity,
        getBrowserStatus,
        closeBrowserToolBackends: resolved.closeBrowserToolBackends,
        getBrowserUsageSettings: () => getRuntimeSettingsForConfig().browser.usage,
        requestPermissionApproval: inlineInteractions.requestPermissionApproval,
        cancelPermissionApproval: channelWiring.cancelPermissionApproval,
        cancelUserQuestion: channelWiring.cancelUserQuestion,
        isControlApproverAllowed: channelWiring.isControlApproverAllowed,
        requestUserAnswer: inlineInteractions.requestUserAnswer,
        renderAgentTodo: (jid, render, options) => liveTurnsEnabled && liveExecution
            ? channelWiring.renderAgentTodo(jid, render, options)
            : Promise.resolve(false),
        renderRichInteraction: (jid, request, options) => liveTurnsEnabled && liveExecution
            ? channelWiring.renderRichInteraction(jid, request, options)
            : Promise.resolve(false),
        mcpHostnameLookup: resolved.mcpHostnameLookup,
    });
    syncGroupSnapshots();
    app.queue.setLiveTurnRunnerRegistrar(liveTurnAuthority
        ? (queueJid, hooks, routing) => liveTurnAuthority.registerLocalRunner(queueJid, hooks, routing)
        : null);
    let handleActiveControlCommand;
    app.queue.setProcessMessagesFn(buildLiveAdmissionProcessor({
        liveTurnAuthority,
        app,
        opsRepository: resolved.opsRepository,
        executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
        messageFetchPageSize: MESSAGE_FETCH_PAGE_SIZE,
        timezone: TIMEZONE,
        enqueueMessageCheck: app.queue.enqueueMessageCheck.bind(app.queue),
        warn: (context, message) => resolved.logger.warn(context, message),
        addReaction: (jid, messageRef, emoji, options) => channelWiring.addReaction(jid, messageRef, emoji, options),
        handleActiveControlCommand: (args) => handleActiveControlCommand?.(args) ?? Promise.resolve(false),
        finalizeAgentTodo: (jid, render, options) => channelWiring.finalizeAgentTodo(jid, render, options),
        finalizeBrowserForLiveTurn: buildLiveTurnBrowserFinalizer({
            getConversationRoutes: () => app.getConversationRoutes(),
            closeBrowserSession: closeBrowser,
            closeBrowserToolBackends: resolved.closeBrowserToolBackends,
            warn: (context, message) => resolved.logger.warn(context, message),
        }),
    }));
    const liveMessageQueue = {
        sendMessage: async (queueJid, text, options) => {
            if (!liveTurnAuthority)
                return app.queue.sendMessage(queueJid, text, options);
            const scope = await liveTurnScopeForQueue({
                app,
                opsRepository: resolved.opsRepository,
                executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
                queueJid,
            });
            if (!scope)
                return false;
            return ((await liveTurnAuthority.routeMessage({
                scope,
                queueJid,
                text,
                idempotencyKey: options?.idempotencyKey ?? `continuation:${randomUUID()}`,
                senderUserIds: options?.senderUserIds,
                cursorAfter: options?.cursorAfter,
            })) === 'queued_to_owner');
        },
        enqueueMessageCheck: (queueJid) => {
            return app.queue.enqueueMessageCheck(queueJid);
        },
        closeStdin: async (queueJid) => {
            if (!liveTurnAuthority) {
                app.queue.closeStdin(queueJid);
                return;
            }
            const scope = await liveTurnScopeForQueue({
                app,
                opsRepository: resolved.opsRepository,
                executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
                queueJid,
            });
            const routed = scope &&
                (await liveTurnAuthority.routeCloseStdin({
                    scope,
                    queueJid,
                    idempotencyKey: `close:${randomUUID()}`,
                }));
            if (!routed)
                app.queue.closeStdin(queueJid);
        },
        stopGroup: async (queueJid) => {
            if (app.queue.stopGroup(queueJid))
                return true;
            if (!liveTurnAuthority)
                return false;
            const scope = await liveTurnScopeForQueue({
                app,
                opsRepository: resolved.opsRepository,
                executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
                queueJid,
            });
            return liveTurnAuthority.routeStop({
                ...(scope ? { scope } : {}),
                aliasJid: queueJid,
                queueJid,
                idempotencyKey: `stop:${randomUUID()}`,
                requestedBy: 'runtime-control',
            });
        },
    };
    registerRuntimeLiveStopMessageAction(channelWiring, app, liveMessageQueue);
    handleActiveControlCommand = async ({ chatJid, queueJid, group, command, message, }) => {
        if (command.kind !== 'stop' &&
            command.kind !== 'new' &&
            command.kind !== 'compact') {
            return false;
        }
        if (command.kind !== 'compact' &&
            !app.queue.isGroupActive(queueJid) &&
            !liveTurnAuthority?.ownsQueue(queueJid)) {
            return false;
        }
        const threadId = typeof message.thread_id === 'string' && message.thread_id.trim()
            ? message.thread_id.trim()
            : undefined;
        if (command.kind === 'compact') {
            return queueActiveCompactionForRuntime({
                hasActiveTurn: app.queue.isGroupActive(queueJid) ||
                    (liveTurnAuthority?.ownsQueue(queueJid) ?? false),
                liveTurnAuthority,
                app,
                opsRepository: resolved.opsRepository,
                executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
                queueJid,
                message,
                sendQueuedReceipt: () => sendActiveCompactionQueuedReceipt({
                    sendMessage: (text, options) => channelWiring.sendMessage(chatJid, text, options),
                    threadId,
                    providerAccountId: group.providerAccountId,
                }),
            });
        }
        if (command.kind === 'new') {
            return handleActiveNewSessionCommand({
                app,
                channelWiring,
                opsRepository: resolved.opsRepository,
                collectSessionMemory: resolved.collectSessionMemory,
                logger: resolved.logger,
                group,
                executionAdapter: app.executionAdapter,
                chatJid,
                queueJid,
                threadId,
                message,
            });
        }
        const stopped = await liveMessageQueue.stopGroup(queueJid);
        if (!stopped) {
            return false;
        }
        app.setAgentCursor(queueJid, encodeGroupMessageCursor(toGroupMessageCursor(message)));
        await app.saveState();
        await sendActiveControlReceipt({
            sendMessage: (text, options) => channelWiring.sendMessage(chatJid, text, options),
            text: command.kind === 'stop'
                ? 'Stopping current run.'
                : 'Started a fresh session.',
            threadId,
            providerAccountId: group.providerAccountId,
        });
        return true;
    };
    const outboundDeliveryRepository = resolved.getOutboundDeliveryRepository?.();
    if (outboundDeliveryRepository) {
        const liveSendProfile = {
            profileId: LIVE_SEND_PROFILE_ID,
            plan: (input) => {
                const segments = splitLiveSendProfileText(input.text);
                return {
                    parts: segments.map((segment) => ({
                        canonicalText: segment,
                    })),
                    canonicalFinalText: input.text,
                };
            },
        };
        const retryTailProfile = {
            profileId: RETRY_TAIL_PROFILE_ID,
            plan: (input) => {
                const providerPayload = input.metadata &&
                    typeof input.metadata === 'object' &&
                    'providerPayload' in input.metadata
                    ? input.metadata.providerPayload
                    : undefined;
                return {
                    parts: [
                        {
                            canonicalText: input.text,
                            providerPayload,
                        },
                    ],
                    canonicalFinalText: input.text,
                };
            },
        };
        const outboundDeliveryService = new OutboundDeliveryService({
            repository: outboundDeliveryRepository,
            profiles: {
                resolve: (profileId) => profileId === RETRY_TAIL_PROFILE_ID
                    ? retryTailProfile
                    : profileId === LIVE_SEND_PROFILE_ID
                        ? liveSendProfile
                        : undefined,
            },
            now: () => nowIso(),
            createId: () => randomUUID(),
            hashSha256Hex: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
        });
        // Observer digest durable send: enqueue under the shared live-send profile
        // (idempotent on the digest's per-day key). The outbound recovery loop below
        // does the provider send; `durablySent` settles the digest once durably sent.
        setObserverDigestGateway({
            enqueue: async (input) => {
                const target = resolveDurableOutboundTarget({
                    defaultAppId: input.appId,
                    jid: input.conversationJid,
                    providerAccountId: input.providerAccountId,
                });
                const result = await outboundDeliveryService.enqueue({
                    appId: target.appId,
                    conversationId: target.conversationId,
                    threadId: canonicalThreadIdFor({
                        jid: input.conversationJid,
                        threadId: input.threadId ?? undefined,
                        providerAccountId: input.providerAccountId,
                    }),
                    profileId: LIVE_SEND_PROFILE_ID,
                    idempotencyKey: input.idempotencyKey,
                    text: input.text,
                    metadata: {
                        destinationJid: input.conversationJid,
                        observerDigest: true,
                    },
                });
                return {
                    outboundDeliveryId: result.delivery.id,
                    durablySent: result.delivery.status === 'sent',
                };
            },
        });
        channelWiring.setDurableOutboundAttemptFactory(async (input) => {
            const target = resolveDurableOutboundTarget({
                defaultAppId: input.appId,
                jid: input.chatJid,
                providerAccountId: input.providerAccountId,
            });
            const started = await outboundDeliveryService.enqueue({
                appId: target.appId,
                conversationId: target.conversationId,
                threadId: canonicalThreadIdFor({
                    jid: input.chatJid,
                    threadId: input.threadId,
                    providerAccountId: input.providerAccountId,
                }),
                profileId: LIVE_SEND_PROFILE_ID,
                idempotencyKey: `live-send:${input.sourceMessageId}`,
                text: input.canonicalText,
                metadata: {
                    sourceMessageId: input.sourceMessageId,
                    sourceProvider: input.provider,
                    destinationJid: input.chatJid,
                    destinationThreadId: input.threadId,
                },
                initialClaim: {
                    claimToken: `claim:live-send:${input.sourceMessageId}`,
                    claimExpiresAt: toIso(nowMs() + 60_000),
                },
            });
            const claimedItems = started.claimedItems;
            if (!started.created || !claimedItems || claimedItems.length === 0) {
                throw new Error(`Durable outbound immediate send claim was not created for ${input.sourceMessageId}.`);
            }
            return createDurableOutboundAttempt({
                outboundDeliveryService,
                deliveryId: started.delivery.id,
                claimedItems,
                sourceMessageId: input.sourceMessageId,
            });
        });
        channelWiring.setRetryTailRecoveryEnqueue(async (input) => {
            const target = resolveDurableOutboundTarget({
                defaultAppId: input.appId,
                jid: input.chatJid,
                providerAccountId: input.providerAccountId,
            });
            const sanitizedRetryTail = sanitizeRetryTailForCanonicalDestination(input.retryTail, input.chatJid);
            if (!sanitizedRetryTail)
                return;
            const retryTailFingerprint = createHash('sha256')
                .update(JSON.stringify({
                canonicalText: sanitizedRetryTail.canonicalText,
                providerPayload: sanitizedRetryTail.providerPayload ?? null,
            }), 'utf8')
                .digest('hex')
                .slice(0, 24);
            await outboundDeliveryService.enqueue({
                appId: target.appId,
                conversationId: target.conversationId,
                threadId: canonicalThreadIdFor({
                    jid: input.chatJid,
                    threadId: input.threadId,
                    providerAccountId: input.providerAccountId,
                }),
                profileId: RETRY_TAIL_PROFILE_ID,
                idempotencyKey: `retry-tail:${input.sourceMessageId}:${retryTailFingerprint}`,
                text: sanitizedRetryTail.canonicalText,
                metadata: {
                    providerPayload: sanitizedRetryTail.providerPayload,
                    sourceMessageId: input.sourceMessageId,
                    sourceProvider: input.provider,
                    destinationJid: input.chatJid,
                    destinationThreadId: input.threadId,
                },
            });
        });
        resolved.startOutboundDeliveryRecoveryLoop({
            service: outboundDeliveryService,
            claimerId: `runtime-recovery:${process.pid}`,
            batchLimit: 25,
            maxBatches: 5,
            intervalMs: 5_000,
            leaseMs: 20_000,
            dispatch: async (claimed) => {
                const destination = await outboundDeliveryService.resolveDestination({
                    appId: claimed.delivery.appId,
                    conversationId: claimed.delivery.conversationId,
                    threadId: claimed.delivery.threadId,
                });
                if (!destination) {
                    return {
                        status: 'failed',
                        error: 'Outbound delivery canonical destination/thread could not be resolved from app-owned conversation metadata.',
                    };
                }
                const destinationJid = destination.conversationJid;
                const destinationThreadId = destination.threadId;
                const destinationDescriptor = channelWiring.describeDestinationJid(destinationJid);
                if (!destinationDescriptor.providerId) {
                    return {
                        status: 'failed',
                        error: 'Outbound delivery canonical destination resolves to an unknown provider JID prefix.',
                    };
                }
                if (destinationDescriptor.providerId !== String(destination.providerId)) {
                    return {
                        status: 'failed',
                        error: 'Outbound delivery canonical destination provider does not match resolved conversation provider connection.',
                    };
                }
                const isCrossAppClaim = claimed.delivery.appId !== destinationDescriptor.runtimeAppId;
                if (isCrossAppClaim && destinationDescriptor.internal !== true) {
                    return {
                        status: 'partially_delivered',
                        error: `Outbound delivery recovery quarantined cross-app external destination ${destinationJid} for app ${String(claimed.delivery.appId)} (providerAccountId ${String(destination.providerAccountId)}); runtime adapter credentials are scoped to app ${String(destinationDescriptor.runtimeAppId)}.`,
                    };
                }
                const payload = claimed.item.providerPayload &&
                    typeof claimed.item.providerPayload === 'object'
                    ? sanitizeRetryTailProviderPayloadDestinationMetadata(claimed.item.providerPayload, destinationJid)
                    : undefined;
                const rawDestinationHint = payload?.conversationJid ??
                    payload?.chatJid ??
                    payload?.jid ??
                    payload?.conversationId ??
                    (destinationJid.startsWith('sl:') ? payload?.channelId : undefined) ??
                    (destinationJid.startsWith('tg:') ? payload?.chatId : undefined);
                const { providerJid: destinationHint, malformedCanonicalHint } = normalizeDestinationHintAgainstCanonical(rawDestinationHint, destinationJid);
                if (malformedCanonicalHint) {
                    return {
                        status: 'failed',
                        error: 'Outbound delivery provider destination hint has malformed canonical conversationId.',
                    };
                }
                const threadHint = payload?.threadId;
                if (typeof destinationHint === 'string' &&
                    destinationHint.trim() &&
                    destinationHint.trim() !== destinationJid) {
                    return {
                        status: 'failed',
                        error: 'Outbound delivery provider destination hint conflicts with canonical conversationId.',
                    };
                }
                if (typeof threadHint === 'string' &&
                    threadHint.trim() &&
                    threadHint.trim() !== (destinationThreadId ?? '')) {
                    return {
                        status: 'failed',
                        error: 'Outbound delivery provider thread hint conflicts with canonical threadId.',
                    };
                }
                const destinationAccount = {
                    providerAccountId: String(destination.providerAccountId),
                };
                if (!channelWiring.hasChannel(destinationJid, destinationAccount)) {
                    return {
                        status: 'failed',
                        error: 'Outbound delivery channel for canonical destination is unavailable.',
                    };
                }
                const recoveryPermit = channelWiring.createRecoveryDispatchPermit({
                    deliveryId: claimed.delivery.id,
                    itemId: claimed.item.id,
                    destinationJid,
                    canonicalText: claimed.item.canonicalText,
                    ...(destinationThreadId ? { threadId: destinationThreadId } : {}),
                });
                try {
                    const deliveryResult = await channelWiring.sendProviderMessage(destinationJid, claimed.item.canonicalText, {
                        permit: recoveryPermit,
                        throwOnMissing: true,
                        messageOptions: {
                            ...destinationAccount,
                            ...(destinationThreadId
                                ? { threadId: destinationThreadId }
                                : {}),
                        },
                    });
                    return {
                        status: 'sent',
                        providerMessageId: deliveryResult?.externalMessageId,
                        providerPayload: deliveryResult,
                    };
                }
                catch (err) {
                    if (isPartialMessageDeliveryError(err)) {
                        const partialMetadata = getPartialMessageDeliveryMetadata(err);
                        const retryTail = sanitizeRetryTailForCanonicalDestination(partialMetadata.retryTail, destinationJid);
                        return {
                            status: 'partially_delivered',
                            error: err.message,
                            deliveredParts: partialMetadata.deliveredParts,
                            totalParts: partialMetadata.totalParts,
                            retryTail,
                        };
                    }
                    if (isAmbiguousDurableDeliveryError(err)) {
                        return {
                            status: 'partially_delivered',
                            error: err.message,
                        };
                    }
                    return {
                        status: 'failed',
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            },
            receiptIdempotencyKeyForItem: (claimed) => `item:${claimed.item.id}:receipt`,
            warn: (meta, message) => resolved.logger.warn(meta, message),
        });
    }
    startIpcWatcher();
    if (jobExecution)
        await startScheduler();
    else {
        markRoleHasNoJobExecution();
        resolved.logger.info({ processRole }, 'Process role has no job execution; scheduler loop not started');
    }
    resolved.logger.info(`Gantry running (default trigger: ${DEFAULT_TRIGGER})`);
    if (!liveTurnsEnabled || !liveExecution) {
        resolved.logger.info('Live-turn execution disabled for this role; skipping live execution services (admission and recovery coordinator)');
        return;
    }
    const messageLoopDeps = {
        getConversationRoutes: () => app.getConversationRoutes(),
        getOrRecoverCursor: app.getOrRecoverCursor,
        setAgentCursor: (chatJid, timestamp) => app.setAgentCursor(chatJid, timestamp),
        saveState: app.saveState,
        hasChannel: (chatJid, options) => channelWiring.hasChannel(chatJid, options),
        setTyping: (chatJid, isTyping, options) => channelWiring.setTyping(chatJid, isTyping, options),
        sendProgressUpdate: (chatJid, text, options) => channelWiring.sendProgressUpdate(chatJid, text, options),
        queue: liveMessageQueue,
        handleActiveControlCommand,
        opsRepository: resolved.opsRepository,
    };
    activeLiveExecutionServices = startLiveExecutionServices({
        appId: channelWiring.getRuntimeAppId(),
        processRole,
        app,
        liveTurnAuthority,
        liveTurnLeaseDeps,
        messageLoopDeps,
        liveAdmissionWakeupSource: liveTurnLeaseDeps
            ? resolved.getLiveAdmissionWakeupSource?.()
            : undefined,
        recoveryCoordinator: options.recoveryCoordinator,
        isEligibleToRecoverLiveTurn,
        alertNoEligibleLiveTurnRecoverer,
        recoverPendingMessages: resolved.recoverPendingMessages,
        registerActiveAdmissionLoop: (loop) => {
            activeLiveAdmissionLoop = loop;
        },
        registerActiveRecoveryLoop: (loop) => {
            activeLiveTurnRecoveryLoop = loop;
        },
        addReaction: (jid, messageRef, emoji, options) => channelWiring.addReaction(jid, messageRef, emoji, options),
        waitingStatus: liveTurns && resolved.getDeploymentMode() === 'fleet'
            ? {
                start: () => startWaitingStatusMonitor({
                    liveTurns,
                    getConversationJids: () => Object.keys(app.getConversationRoutes()),
                    sendStatus: (conversationJid, text) => channelWiring.sendProgressUpdate(conversationJid, text),
                    warn: (context, message) => resolved.logger.warn(context, message),
                }),
                register: (monitor) => {
                    activeWaitingStatusMonitor = monitor;
                },
            }
            : undefined,
        onPollingCrash: (err) => {
            resolved.logger.fatal({ err }, 'Message loop crashed unexpectedly');
            resolved.exit(1);
        },
        info: (obj, msg) => resolved.logger.info(obj, msg),
        warn: (context, message) => resolved.logger.warn(context, message),
    });
}
