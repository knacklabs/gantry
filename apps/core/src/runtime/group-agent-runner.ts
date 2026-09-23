// prettier-ignore
import type { AgentControlOverrides, ConversationRoute } from '../domain/types.js';
import { collectCompactBoundaryMemory } from '../jobs/compact-memory.js';
import { defaultModelStatusSelection } from '../session/session-model-status.js';
import type { AgentOutput } from './agent-spawn.js';
import { spawnAgent } from './agent-spawn.js';
import { resolveAgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type {
  GroupProcessingDeps,
  GroupProcessingRepository,
} from './group-processing-types.js';
import { memoryScopeForConversationKind } from './group-run-context.js';
import {
  resolveSingleNonSelfSenderId,
  buildRuntimeRunOptions,
  completeFailedRuntimeSessionRun,
  completeSuccessfulRuntimeSessionRun,
  createRuntimeResultSummaryAccumulator,
  summarizeRuntimeResultForPersistence,
} from './session-resume-runtime.js';
import { createRuntimeModelStatusAccess as createModelStatus } from './model-status-store.js';
import { recordRuntimeModelUsage } from './model-status-output.js';
import { buildBoundedMemoryRecallQuery } from '../memory/app-memory-recall-query.js';
import { appIdFromConversationJid } from '../shared/app-conversation-jid.js';
import {
  loadPatternsContext,
  markPatternsContextSurfaced,
} from '../shared/pattern-candidate-block.js';
import { patternSubjectForScope } from '../shared/pattern-candidate-subject.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import {
  runFamilyFailoverLoop,
  publishRunFailoverEvent,
} from './failover-candidate-loop.js';
import { outcomeForPatternCandidateStatus } from './proactive-surfacing-metrics.js';
import {
  proactiveSurfacingAllowed,
  publishProactiveSurfacingOutcomeEvent,
} from './proactive-surfacing-gate.js';
import { forwardRuntimeEvents } from './runtime-event-forwarding.js';
import { isMissingProviderSessionError } from './failover-eligibility.js';
import { createConfiguredRunTokenBudget } from './agent-spawn-host.js';
import {
  logger,
  redactString,
  updateLogContext,
  withLogContext,
} from '../infrastructure/logging/logger.js';
import { memoryReviewerApproverAllowed } from './group-agent-runner-memory-review.js';
import { prepareCompactionDeltaReplay } from './group-agent-runner-compaction-delta.js';
import { maintenanceCompactionPromptForExecutionProvider } from './group-agent-runner-maintenance-compaction.js';
import { hasAsyncTaskRepository } from './group-agent-runner-async-task-repository.js';
import { resolveInitialGroupExecutionProviderId } from './group-initial-execution-provider.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import {
  prepareProviderSessionFailoverAttempt,
  prepareProviderSessionContext,
  raiseProviderSessionMarkFromOutput,
  retireMissingProviderSession,
} from './group-agent-runner-context-ceiling.js';
import {
  createGroupProviderSessionRuntime,
  createProviderSessionContinuityResolver,
  initialProviderSessionIdentifiers,
  isStoppedProviderOutput,
  type ProviderSessionRunOptions,
} from './group-agent-runner-provider-session.js';
import { resolveGroupAgentAccessContext } from './group-agent-access-context.js';
const DEFAULT_ASSISTANT_NAME = 'Gantry';
const WORKSPACE_FOLDER_INPUT_KEY = `workspace${'Folder'}`;
export type GroupAgentRunResult = 'success' | 'error' | 'stopped';
export function createGroupAgentRunner(input: {
  deps: GroupProcessingDeps;
  ops: () => GroupProcessingRepository;
}) {
  const { deps, ops } = input;
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const collectSessionMemory = deps.collectSessionMemory;
  async function runAgentWithContext(
    group: ConversationRoute,
    prompt: string,
    chatJid: string,
    queueJid: string,
    onOutput?: (output: AgentOutput) => Promise<void>,
    options?: ProviderSessionRunOptions & {
      timeoutMs?: number;
      turnMessages?: readonly {
        id?: string;
        content?: string | null;
        sender?: string | null;
        timestamp?: string;
        is_from_me?: boolean | null;
      }[];
      liveStopActionToken?: string;
      maintenanceCompaction?: boolean;
      responseSchema?: Record<string, unknown>;
      agentControls?: AgentControlOverrides;
    },
  ): Promise<GroupAgentRunResult> {
    const agentHarness = deps.getSelectedAgentHarness(group.folder);
    const turnAppId = appIdFromConversationJid(chatJid) ?? 'default';
    const defaultInteractiveModel =
      deps.getDefaultInteractiveModel?.(group.folder) ?? 'opus';
    const initialProvider = await resolveInitialGroupExecutionProviderId({
      group,
      appId: turnAppId,
      defaultModel: defaultInteractiveModel,
      listConfiguredProviders: deps.getConfiguredModelProviders,
      familyOrder: deps.getModelFamilyOrder?.(),
      executionAdapter: deps.executionAdapter,
      agentHarness,
    });
    const failoverCandidates = initialProvider.failoverCandidates;
    const firstModel = initialProvider.firstModel;
    let executionProviderId = initialProvider.executionProviderId;
    let previousExecutionProviderId = executionProviderId;
    const continuityFor = createProviderSessionContinuityResolver({
      registry: deps.executionAdapters,
      fallback: deps.executionAdapter,
    });
    let providerSessionContinuity = continuityFor(executionProviderId);
    const maintenanceCompactionPrompt = options?.maintenanceCompaction
      ? maintenanceCompactionPromptForExecutionProvider(
          executionProviderId,
          deps,
        )
      : undefined;
    if (options?.maintenanceCompaction && !maintenanceCompactionPrompt)
      return 'error';
    const sessionThreadId = options?.memoryContext?.threadId ?? null;
    const modelStatus = createModelStatus(group.folder, sessionThreadId);
    const runTokenBudget = createConfiguredRunTokenBudget(group.folder);
    const streamedResult = createRuntimeResultSummaryAccumulator();
    const loadTurnContext = async (
      promoteReadyProviderSession: boolean,
      hydrateMemory = true,
    ) =>
      ops().getAgentTurnContext?.({
        appId: turnAppId,
        agentFolder: group.folder,
        executionProviderId,
        providerSessionContinuity,
        conversationJid: chatJid,
        providerAccountId: group.providerAccountId,
        threadId: sessionThreadId,
        conversationKind: group.conversationKind,
        memoryUserId: options?.memoryContext?.userId,
        hydrationMode: 'first_visible',
        promoteReadyProviderSession,
        hydrateMemory,
        query:
          options?.memoryContext?.source === 'message'
            ? buildBoundedMemoryRecallQuery(options.memoryContext.recallQuery)
            : undefined,
      });
    const compactionDeltaReplay = await prepareCompactionDeltaReplay({
      turnContext: await loadTurnContext(false),
      loadTurnContext,
      repository: ops(),
      executionProviderId,
      group,
      chatJid,
      threadId: sessionThreadId,
      ...(providerSessionContinuity === 'durable_resume'
        ? { maintenanceProviderSession: options?.maintenanceProviderSession }
        : { maintenanceProviderSession: undefined }),
    });
    let turnContext = compactionDeltaReplay.turnContext;
    const runtimeAppId = turnContext?.appId ?? turnAppId;
    const defaultRuntimeModel =
      group.agentConfig?.model ?? defaultInteractiveModel;
    const forwardedRuntimeEventKeys = new Set<string>();
    const defaultMemoryScope = memoryScopeForConversationKind(
      group.conversationKind,
    );
    const memoryReviewerUserId = resolveSingleNonSelfSenderId(
      options?.turnMessages ?? [],
    );
    const memoryReviewerIsControlApprover = await memoryReviewerApproverAllowed(
      deps,
      chatJid,
      group.folder,
      memoryReviewerUserId,
    );
    const runState: { runId?: string } = {};
    const liveRunFenced = !!options?.existingRunLeaseToken;
    let {
      latestProviderSessionId,
      currentProviderSessionId,
      resumeProviderSessionId,
      resumeExternalSessionId,
      providerSessionPersistenceAllowed,
    } = initialProviderSessionIdentifiers({
      continuity: providerSessionContinuity,
      maintenanceProviderSession: options?.maintenanceProviderSession,
      turnContext,
    });
    const providerSessionRuntime = createGroupProviderSessionRuntime({
      repository: ops,
      runId: () => runState.runId,
      state: () => ({
        persistenceAllowed: providerSessionPersistenceAllowed,
        latestProviderSessionId,
        turnContext,
        executionProviderId,
      }),
      options,
      group,
      threadId: sessionThreadId,
      appId: runtimeAppId,
      conversationJid: chatJid,
      accessFingerprint: () => currentAccessFingerprint,
      onPersisted: (providerSessionId) => {
        latestProviderSessionId = providerSessionId;
        currentProviderSessionId = providerSessionId;
      },
    });
    const updateRunProviderMetadata = providerSessionRuntime.update;
    const persistProviderSessionFromOutput =
      providerSessionRuntime.persistOutput;
    const wrappedOnOutput = async (output: AgentOutput) => {
      await persistProviderSessionFromOutput(output);
      let normalizedUsageRuntimeEvent:
        | NonNullable<AgentOutput['runtimeEvents']>[number]
        | undefined;
      if (output.usage) {
        try {
          recordRuntimeModelUsage({
            group,
            threadId: sessionThreadId,
            usage: output.usage,
            usageEventId: output.usageEventId,
            getDefaultModel: () => defaultRuntimeModel,
          });
          normalizedUsageRuntimeEvent = {
            eventType: RUNTIME_EVENT_TYPES.MODEL_USAGE,
            payload: {
              usage: output.usage,
              usageEventId: output.usageEventId,
              modelAlias: output.usage.model ?? defaultRuntimeModel,
              providerId: output.usage.provider,
            } satisfies import('../domain/events/events.js').NormalizedUsageEventPayload,
          };
        } catch (err) {
          logger.warn(
            { err, group: group.name },
            'Failed to prepare normalized model usage runtime event',
          );
        }
      }
      if (output.contextUsage) {
        modelStatus.updateSelection({
          ...defaultModelStatusSelection(defaultRuntimeModel),
          selectionSource: group.agentConfig?.model
            ? 'session override'
            : 'chat default',
          contextUsage: output.contextUsage,
        });
      }
      if (output.status !== 'error' && output.result) {
        streamedResult.append(String(output.result));
      }
      output = runTokenBudget.enforce(output);
      if (runTokenBudget.exceeded) deps.queue.stopGroup?.(queueJid);
      await forwardRuntimeEvents({
        output,
        publishRuntimeEvent: deps.publishRuntimeEvent,
        runtimeAppId,
        turnAgentId: turnContext?.agentId,
        runId: runState.runId,
        chatJid,
        sessionThreadId,
        forwardedKeys: forwardedRuntimeEventKeys,
      });
      if (normalizedUsageRuntimeEvent) {
        try {
          await forwardRuntimeEvents({
            output: {
              ...output,
              runtimeEvents: [normalizedUsageRuntimeEvent],
            },
            publishRuntimeEvent: deps.publishRuntimeEvent,
            runtimeAppId,
            turnAgentId: turnContext?.agentId,
            runId: runState.runId,
            chatJid,
            sessionThreadId,
            forwardedKeys: forwardedRuntimeEventKeys,
          });
        } catch (err) {
          logger.warn(
            { err, group: group.name },
            'Failed to publish normalized model usage runtime event',
          );
        }
      }
      if (
        output.compactBoundary &&
        turnContext?.agentSessionId &&
        collectSessionMemory
      ) {
        await collectCompactBoundaryMemory({
          compactBoundary: output.compactBoundary,
          agentSessionId: turnContext.agentSessionId,
          collectMemory: collectSessionMemory,
          defaultScope: defaultMemoryScope,
          logger,
          context: { group: group.name },
        });
      }
      await onOutput?.(output);
    };
    const {
      configuredToolPolicy,
      selectedSkillContext,
      semanticCapabilities,
      attachedMcpSourceIds,
      capabilityCatalog,
      currentAccessFingerprint,
      approvedSkillContextBlock,
      accessSnapshot,
    } = await resolveGroupAgentAccessContext({
      deps,
      turnContext,
      catalogScope: {
        appId: turnContext?.appId ?? runtimeAppId,
        agentId:
          turnContext?.agentId ?? memoryAgentIdForWorkspaceFolder(group.folder),
      },
      agentFolder: group.folder,
      personId: options?.memoryContext?.userId,
      routeScope: {
        conversationId: group.conversationId,
        threadId: sessionThreadId ?? undefined,
      },
    });
    if (providerSessionContinuity === 'durable_resume') {
      const preparedProviderSession = await prepareProviderSessionContext({
        turnContext,
        latestProviderSessionId,
        currentProviderSessionId,
        resumeProviderSessionId,
        resumeExternalSessionId,
        maintenanceProviderSession: Boolean(
          options?.maintenanceProviderSession,
        ),
        currentAccessFingerprint,
        repository: ops(),
        executionProviderId,
        publish: deps.publishRuntimeEvent,
        appId: runtimeAppId,
        groupName: group.name,
        loadTurnContext,
        onRetired: (reference) =>
          options?.retiredProviderSessions?.push(reference),
      });
      turnContext = preparedProviderSession.turnContext;
      ({
        latestProviderSessionId,
        currentProviderSessionId,
        resumeProviderSessionId,
        resumeExternalSessionId,
        providerSessionPersistenceAllowed,
      } = preparedProviderSession);
    } else {
      latestProviderSessionId = undefined;
      currentProviderSessionId = undefined;
      resumeProviderSessionId = undefined;
      resumeExternalSessionId = undefined;
      providerSessionPersistenceAllowed = false;
    }
    const surfacingScope = {
      appId: runtimeAppId,
      agentId:
        turnContext?.agentId ?? memoryAgentIdForWorkspaceFolder(group.folder),
      folder: group.folder,
      conversationId: chatJid,
      conversationKind: group.conversationKind,
      userId: options?.memoryContext?.userId,
    };
    const patternCandidateRepo = deps.getPatternCandidateRepository?.();
    const surfacingGate = await proactiveSurfacingAllowed(deps, surfacingScope);
    let patternsContext = { block: '', surfacedCandidateIds: [] as string[] };
    if (surfacingGate.allowed) {
      try {
        patternsContext = await loadPatternsContext(
          patternCandidateRepo,
          surfacingScope,
        );
      } catch {
        publishProactiveSurfacingOutcomeEvent({
          publish: deps.publishRuntimeEvent,
          appId: runtimeAppId,
          agentId: turnContext?.agentId,
          runId: runState.runId,
          conversationId: chatJid,
          threadId: sessionThreadId,
          subjectId: surfacingGate.subjectId,
          candidates: [],
          outcome: 'skipped_error',
        });
      }
    } else if (surfacingGate.failClosedOutcome) {
      publishProactiveSurfacingOutcomeEvent({
        publish: deps.publishRuntimeEvent,
        appId: runtimeAppId,
        agentId: turnContext?.agentId,
        runId: runState.runId,
        conversationId: chatJid,
        threadId: sessionThreadId,
        subjectId: surfacingGate.subjectId,
        candidates: [],
        outcome: surfacingGate.failClosedOutcome,
      });
    }
    let memoryContextBlock = [
      compactionDeltaReplay.block,
      turnContext?.memoryContextBlock,
      patternsContext.block,
      approvedSkillContextBlock,
    ]
      .filter((block): block is string => Boolean(block?.trim()))
      .join('\n\n');
    runState.runId = options?.existingRunId
      ? options.existingRunId
      : turnContext?.agentSessionId
        ? await ops().createSessionAgentRun?.({
            agentSessionId: turnContext.agentSessionId,
            executionProviderId,
            providerSessionId: resumeProviderSessionId,
            cause:
              options?.memoryContext?.source === 'command'
                ? 'control'
                : 'message',
          })
        : undefined;
    updateLogContext({
      runId: runState.runId,
      appId: runtimeAppId,
      agentId:
        turnContext?.agentId ?? memoryAgentIdForWorkspaceFolder(group.folder),
    });
    try {
      const credentialBroker = await deps.getCredentialBroker?.();
      const runOptions = buildRuntimeRunOptions({
        timeoutMs: options?.timeoutMs,
        credentialBroker,
        skillRepository: deps.getSkillRepository?.(),
        skillArtifactStore: deps.getSkillArtifactStore?.(),
        mcpServerRepository: deps.getMcpServerRepository?.(),
        capabilitySecretRepository: deps.getCapabilitySecretRepository?.(),
        mcpHostnameLookup: deps.getMcpHostnameLookup?.(),
        mcpDnsValidationCache: deps.getMcpDnsValidationCache?.(),
        publishRuntimeEvent: deps.publishRuntimeEvent,
        executionAdapter: deps.executionAdapter,
        executionAdapters: deps.executionAdapters,
        runnerSandboxProvider: deps.runnerSandboxProvider,
        asyncTaskRepositoryAvailable: hasAsyncTaskRepository(deps),
        conversationRoutes: deps.getConversationRoutes?.() ?? {},
        turnContext,
      });
      if (accessSnapshot) runOptions.accessSnapshot = accessSnapshot;
      const expireTurnProviderSession = (reason: string) =>
        retireMissingProviderSession({
          reason,
          repository: ops(),
          turnContext,
          executionProviderId,
          publish: deps.publishRuntimeEvent,
          appId: runtimeAppId,
          groupName: group.name,
          runId: runState.runId,
          onRetired: (reference) =>
            options?.retiredProviderSessions?.push(reference),
          clearRunProviderSession: () =>
            updateRunProviderMetadata({ providerSessionId: null }),
        });
      const invokeAgent = (agentInput: {
        memoryContextBlock?: string;
        resumeSessionId?: string;
        model?: string;
      }) =>
        runAgentImpl(
          group,
          {
            prompt: maintenanceCompactionPrompt ?? prompt,
            appId: runtimeAppId,
            ...(turnContext?.agentId ? { agentId: turnContext.agentId } : {}),
            ...(agentInput.model ? { model: agentInput.model } : {}),
            chatJid,
            // Exact key the finalizer consumes activity with; stored with the
            // browser credential so the IPC side never rebuilds it.
            turnQueueKey: queueJid,
            threadId: options?.memoryContext?.threadId,
            memoryUserId: options?.memoryContext?.userId,
            memoryUserLabel: options?.memoryContext?.label,
            memoryDefaultScope: defaultMemoryScope,
            memoryReviewerIsControlApprover,
            persona: group.agentConfig?.persona,
            toolPolicyRules: configuredToolPolicy.toolPolicyRules,
            runtimeAccess: configuredToolPolicy.runtimeAccess,
            attachedSkillSourceIds: selectedSkillContext.ids,
            selectedSkillDisplays: selectedSkillContext.displays,
            attachedMcpSourceIds,
            semanticCapabilities,
            capabilityCatalog,
            providerSessionAccessFingerprint: currentAccessFingerprint,
            assistantName: group.trigger || DEFAULT_ASSISTANT_NAME,
            thinking: group.agentConfig?.thinking,
            memoryContextBlock: agentInput.memoryContextBlock,
            responseSchema: options?.responseSchema,
            effort: options?.agentControls?.effort,
            configuredThinking: options?.agentControls?.thinking,
            maxOutputTokens: options?.agentControls?.maxOutputTokens,
            ...(agentInput.resumeSessionId
              ? { sessionId: agentInput.resumeSessionId }
              : {}),
            ...(options?.existingRunId &&
            options.existingRunLeaseToken &&
            typeof options.existingRunLeaseFencingVersion === 'number'
              ? {
                  runId: options.existingRunId,
                  runLeaseToken: options.existingRunLeaseToken,
                  runLeaseFencingVersion:
                    options.existingRunLeaseFencingVersion,
                }
              : {}),
            ...(options?.liveStopActionToken
              ? { liveStopActionToken: options.liveStopActionToken }
              : {}),
            [WORKSPACE_FOLDER_INPUT_KEY]: group.folder,
          } as Parameters<typeof runAgentImpl>[1],
          (proc, runHandle) => {
            if (providerSessionContinuity === 'durable_resume') {
              providerSessionRuntime.trackProviderRun(runHandle);
            }
            const registerOptions =
              memoryReviewerIsControlApprover && memoryReviewerUserId
                ? { requiredContinuationUserId: memoryReviewerUserId }
                : undefined;
            const stopAliasJids = [
              ...(queueJid === chatJid ? [] : [chatJid]),
              ...(options?.liveStopActionToken
                ? [options.liveStopActionToken]
                : []),
            ];
            deps.queue.registerProcess(
              queueJid,
              proc,
              runHandle,
              group.folder,
              stopAliasJids,
              options?.memoryContext?.threadId,
              registerOptions,
            );
          },
          wrappedOnOutput,
          { ...runOptions, correlationRunId: runState.runId },
        ).then((output) => runTokenBudget.enforce(output));
      let output = await invokeAgent({
        memoryContextBlock,
        ...(firstModel ? { model: firstModel } : {}),
        resumeSessionId: resumeExternalSessionId,
      });
      const activeExecutionAdapter = resolveAgentExecutionAdapter({
        executionProviderId,
        registry: deps.executionAdapters,
        fallback: deps.executionAdapter,
      });
      const adapterMissingProviderSession =
        activeExecutionAdapter?.isMissingProviderSessionError?.(
          output.error,
        ) === true;
      const missingProviderSession =
        adapterMissingProviderSession ||
        isMissingProviderSessionError(output.error);
      if (
        output.status === 'error' &&
        providerSessionContinuity === 'durable_resume' &&
        missingProviderSession &&
        (await expireTurnProviderSession(output.error ?? 'missing session'))
      ) {
        latestProviderSessionId = undefined;
        currentProviderSessionId = undefined;
        resumeExternalSessionId = undefined;
        output = await invokeAgent({
          memoryContextBlock,
          ...(firstModel ? { model: firstModel } : {}),
        });
      }
      const prepareFailoverAttempt = async (): Promise<void> => {
        providerSessionContinuity = continuityFor(executionProviderId);
        const preparedProviderSession =
          await prepareProviderSessionFailoverAttempt({
            previousContext: turnContext,
            previousExecutionProviderId,
            loadTurnContext,
            repository: ops(),
            executionProviderId,
            providerSessionContinuity,
            maintenanceProviderSession: options?.maintenanceProviderSession,
            group,
            chatJid,
            threadId: sessionThreadId,
            currentAccessFingerprint,
            publish: deps.publishRuntimeEvent,
            appId: runtimeAppId,
            groupName: group.name,
            patternsContextBlock: patternsContext.block,
            approvedSkillContextBlock,
            updateRunProviderMetadata,
            onRetired: (reference) =>
              options?.retiredProviderSessions?.push(reference),
          });
        turnContext = preparedProviderSession.turnContext;
        ({
          latestProviderSessionId,
          currentProviderSessionId,
          resumeProviderSessionId,
          resumeExternalSessionId,
          providerSessionPersistenceAllowed,
        } = preparedProviderSession);
        memoryContextBlock = preparedProviderSession.memoryContextBlock;
      };
      output = await runFamilyFailoverLoop({
        candidates: failoverCandidates,
        initialOutput: output,
        fallbackProviderId: executionProviderId,
        agentHarness,
        hasStreamedOutput: () => (streamedResult.snapshot()?.length ?? 0) > 0,
        invoke: async (model) => {
          await prepareFailoverAttempt();
          return invokeAgent({
            memoryContextBlock,
            model,
            resumeSessionId: resumeExternalSessionId,
          });
        },
        onFailover: (toProviderId, details) => {
          const fromProviderId = executionProviderId;
          previousExecutionProviderId = fromProviderId;
          executionProviderId = toProviderId;
          publishRunFailoverEvent({
            publish: deps.publishRuntimeEvent,
            appId: runtimeAppId,
            agentId: turnContext?.agentId,
            runId: runState.runId,
            conversationId: chatJid,
            threadId: sessionThreadId,
            fromProvider: fromProviderId,
            family: group.agentConfig?.model ?? null,
            details,
          });
          return fromProviderId;
        },
        log: (message) =>
          logger.warn({ group: group.name }, redactString(message)),
      });
      if (providerSessionContinuity === 'durable_resume') {
        await raiseProviderSessionMarkFromOutput({
          output,
          repository: ops(),
          turnContext,
          executionProviderId,
          providerSessionId: currentProviderSessionId,
          externalSessionId: latestProviderSessionId,
        });
      }
      await forwardRuntimeEvents({
        output,
        publishRuntimeEvent: deps.publishRuntimeEvent,
        runtimeAppId,
        turnAgentId: turnContext?.agentId,
        runId: runState.runId,
        chatJid,
        sessionThreadId,
        forwardedKeys: forwardedRuntimeEventKeys,
      });
      if (output.status === 'error') {
        if (isStoppedProviderOutput(output)) {
          logger.warn({ group: group.name }, 'Agent runner stopped by request');
          if (!liveRunFenced) {
            await completeFailedRuntimeSessionRun({
              ops: ops(),
              runId: runState.runId,
              errorSummary: output.error ?? 'Agent runner stopped by request',
            });
          }
          return 'stopped';
        }
        const redactedError = output.error && redactString(output.error);
        logger.error(
          { group: group.name, error: redactedError },
          'Agent runner error',
        );
        if (!liveRunFenced) {
          await completeFailedRuntimeSessionRun({
            ops: ops(),
            runId: runState.runId,
            errorSummary: output.error ?? 'Agent runner error',
          });
        }
        return 'error';
      }
      if (!liveRunFenced) {
        await completeSuccessfulRuntimeSessionRun({
          ops: ops(),
          group,
          chatJid,
          threadId: sessionThreadId,
          conversationKind: group.conversationKind,
          memoryUserId: options?.memoryContext?.userId,
          agentSessionId: turnContext?.agentSessionId,
          agentSessionResetAt: turnContext?.agentSessionResetAt ?? null,
          runId: runState.runId,
          result:
            output.result == null
              ? streamedResult.snapshot()
              : summarizeRuntimeResultForPersistence(output.result),
        });
      }
      await compactionDeltaReplay.markApplied?.(ops());
      await markPatternsContextSurfaced(
        patternCandidateRepo,
        patternsContext.surfacedCandidateIds,
      );
      try {
        const surfacedSubject = patternSubjectForScope(surfacingScope);
        if (surfacedSubject && patternCandidateRepo) {
          for (const id of patternsContext.surfacedCandidateIds) {
            const candidate = await patternCandidateRepo.getById(id);
            if (!candidate) continue;
            publishProactiveSurfacingOutcomeEvent({
              publish: deps.publishRuntimeEvent,
              appId: runtimeAppId,
              agentId: turnContext?.agentId,
              runId: runState.runId,
              conversationId: chatJid,
              threadId: sessionThreadId,
              subjectId: surfacedSubject.subjectId,
              candidates: [
                {
                  signature: candidate.signature,
                  status: candidate.candidateStatus,
                },
              ],
              outcome: outcomeForPatternCandidateStatus(
                candidate.candidateStatus,
              ),
            });
          }
        }
      } catch {
        // Ignore proactive surfacing metric failures.
      }
      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      if (!liveRunFenced) {
        await completeFailedRuntimeSessionRun({
          ops: ops(),
          runId: runState.runId,
          errorSummary: err instanceof Error ? err.message : String(err),
        });
      }
      return 'error';
    }
  }
  return (...args: Parameters<typeof runAgentWithContext>) => {
    const [group, , chatJid] = args;
    return withLogContext(
      {
        appId: appIdFromConversationJid(chatJid) ?? 'default',
        agentId: memoryAgentIdForWorkspaceFolder(group.folder),
      },
      () => runAgentWithContext(...args),
    );
  };
}
