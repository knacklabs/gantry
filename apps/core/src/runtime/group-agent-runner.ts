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
import {
  memoryScopeForConversationKind,
  resolveTurnToolPolicy,
  resolveTurnSemanticCapabilities,
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
} from './group-run-context.js';
import {
  resolveSingleNonSelfSenderId,
  buildApprovedSkillContextBlock,
  buildRuntimeRunOptions,
  completeFailedRuntimeSessionRun,
  completeSuccessfulRuntimeSessionRun,
  createRuntimeResultSummaryAccumulator,
  summarizeRuntimeResultForPersistence,
} from './session-resume-runtime.js';
import { createRuntimeModelStatusAccess as createModelStatus } from './model-status-store.js';
import { recordRuntimeModelUsage } from './model-status-output.js';
import {
  buildProviderSessionAccessFingerprint,
  providerSessionAccessFingerprintMatches,
} from './provider-session-access-fingerprint.js';
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
const DEFAULT_ASSISTANT_NAME = 'Gantry';
const WORKSPACE_FOLDER_INPUT_KEY = `workspace${'Folder'}`;
export type GroupAgentRunResult = 'success' | 'error' | 'stopped';
function redactRuntimeError(error: string | undefined): string | undefined {
  return error ? redactString(error) : undefined;
}
function isStoppedByRequest(output: AgentOutput): boolean {
  return (
    output.status === 'error' &&
    /\bstopped by request\b/i.test(output.error ?? '')
  );
}
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
    options?: {
      timeoutMs?: number;
      memoryContext?: {
        source: 'message' | 'command';
        userId?: string;
        threadId?: string;
        recallQuery?: string;
      };
      turnMessages?: readonly {
        id?: string;
        content?: string | null;
        sender?: string | null;
        timestamp?: string;
        is_from_me?: boolean | null;
      }[];
      existingRunId?: string;
      existingRunLeaseToken?: string;
      existingRunLeaseWorkerInstanceId?: string;
      existingRunLeaseFencingVersion?: number;
      liveStopActionToken?: string;
      maintenanceProviderSession?: {
        providerSessionId: string;
        externalSessionId: string;
      };
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
    const initialModelSelection = initialProvider.initialModelSelection;
    const failoverCandidates = initialProvider.failoverCandidates;
    const firstModel = initialProvider.firstModel;
    let executionProviderId = initialProvider.executionProviderId;
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
    const loadTurnContext = async (promoteReadyProviderSession: boolean) =>
      ops().getAgentTurnContext?.({
        appId: turnAppId,
        agentFolder: group.folder,
        executionProviderId,
        conversationJid: chatJid,
        providerAccountId: group.providerAccountId,
        threadId: sessionThreadId,
        conversationKind: group.conversationKind,
        memoryUserId: options?.memoryContext?.userId,
        hydrationMode: 'first_visible',
        promoteReadyProviderSession,
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
      maintenanceProviderSession: options?.maintenanceProviderSession,
    });
    const turnContext = compactionDeltaReplay.turnContext;
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
    let latestProviderSessionId =
      turnContext?.externalSessionId?.trim() || undefined;
    let resumeProviderSessionId =
      options?.maintenanceProviderSession?.providerSessionId ??
      turnContext?.providerSessionId;
    let resumeExternalSessionId =
      options?.maintenanceProviderSession?.externalSessionId ??
      turnContext?.externalSessionId;
    const updateRunProviderMetadata = async (input: {
      providerRunId?: string | null;
      providerSessionId?: string | null;
    }): Promise<void> => {
      if (!runState.runId) return;
      const repository = ops();
      if (!repository.updateAgentRunProviderMetadata) return;
      await repository
        .updateAgentRunProviderMetadata({
          runId: runState.runId,
          ...input,
          ...(options?.existingRunLeaseToken
            ? {
                leaseToken: options.existingRunLeaseToken,
                workerInstanceId: options.existingRunLeaseWorkerInstanceId,
                fencingVersion: options.existingRunLeaseFencingVersion,
              }
            : {}),
        })
        .catch((err) => {
          logger.warn(
            { err, group: group.name, runId: runState.runId },
            'Failed to update runtime run provider metadata',
          );
        });
    };
    const persistProviderSessionFromOutput = async (output: AgentOutput) => {
      if (output.status === 'error') return;
      if (
        turnContext?.latestProviderSessionLocked ||
        options?.maintenanceProviderSession
      )
        return;
      const nextSessionId = (
        output.providerSession?.externalSessionId ?? output.newSessionId
      )?.trim();
      if (
        !nextSessionId ||
        nextSessionId === latestProviderSessionId ||
        !turnContext?.agentSessionId ||
        !ops().setSession
      ) {
        return;
      }
      const persisted = await ops().setSession(
        group.folder,
        nextSessionId,
        sessionThreadId,
        {
          appId: runtimeAppId,
          executionProviderId,
          conversationJid: chatJid,
          providerAccountId: group.providerAccountId,
          conversationKind: group.conversationKind,
          memoryUserId: options?.memoryContext?.userId,
          expectedAgentSessionId: turnContext.agentSessionId,
          expectedAgentSessionResetAt: turnContext.agentSessionResetAt ?? null,
          accessFingerprint: currentAccessFingerprint,
        },
      );
      if (persisted === false) {
        logger.warn(
          { group: group.name },
          'Provider session update skipped because turn ownership changed',
        );
        return;
      }
      latestProviderSessionId = nextSessionId;
      await updateRunProviderMetadata({ providerSessionId: nextSessionId });
    };
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
    const approvedSkillContextBlock = await buildApprovedSkillContextBlock({
      skillRepository: deps.getSkillRepository?.(),
      skillArtifactStore: deps.getSkillArtifactStore?.(),
      turnContext,
    });
    const [configuredToolPolicy, selectedSkillContext, semanticCapabilities] =
      await Promise.all([
        resolveTurnToolPolicy(deps, turnContext),
        resolveTurnSelectedSkillContext(deps, turnContext),
        resolveTurnSemanticCapabilities(deps, turnContext),
      ]);
    const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(
      deps,
      turnContext,
      configuredToolPolicy.toolPolicyRules,
    );
    const currentAccessFingerprint = buildProviderSessionAccessFingerprint({
      toolPolicyRules: configuredToolPolicy.toolPolicyRules,
      runtimeAccess: configuredToolPolicy.runtimeAccess,
      attachedSkillSourceIds: selectedSkillContext.ids,
      attachedMcpSourceIds,
      semanticCapabilities,
    });
    if (
      turnContext?.providerSessionId &&
      turnContext.externalSessionId &&
      !providerSessionAccessFingerprintMatches(
        turnContext.providerSessionAccessFingerprint,
        currentAccessFingerprint,
      )
    ) {
      if (ops().expireProviderSession) {
        await ops().expireProviderSession?.({
          providerSessionId: turnContext.providerSessionId,
          agentSessionId: turnContext.agentSessionId,
          provider: executionProviderId,
          externalSessionId: turnContext.externalSessionId,
        });
      }
      latestProviderSessionId = undefined;
      resumeProviderSessionId = undefined;
      resumeExternalSessionId = undefined;
      logger.warn(
        {
          group: group.name,
          agentId: turnContext.agentId,
          agentSessionId: turnContext.agentSessionId,
        },
        'Expired provider session because runtime access projection changed',
      );
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
    const memoryContextBlock = [
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
      const expireTurnProviderSession = async (
        reason: string,
      ): Promise<boolean> => {
        if (
          !turnContext?.providerSessionId ||
          !turnContext.agentSessionId ||
          !turnContext.externalSessionId ||
          !ops().expireProviderSession
        ) {
          return false;
        }
        await ops().expireProviderSession?.({
          providerSessionId: turnContext.providerSessionId,
          agentSessionId: turnContext.agentSessionId,
          provider: executionProviderId,
          externalSessionId: turnContext.externalSessionId,
        });
        latestProviderSessionId = undefined;
        await updateRunProviderMetadata({ providerSessionId: null });
        logger.warn(
          { group: group.name, reason: redactString(reason) },
          'Expired stale provider session and retrying without resume',
        );
        return true;
      };
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
            threadId: options?.memoryContext?.threadId,
            memoryUserId: options?.memoryContext?.userId,
            memoryDefaultScope: defaultMemoryScope,
            memoryReviewerIsControlApprover,
            persona: group.agentConfig?.persona,
            toolPolicyRules: configuredToolPolicy.toolPolicyRules,
            runtimeAccess: configuredToolPolicy.runtimeAccess,
            attachedSkillSourceIds: selectedSkillContext.ids,
            selectedSkillDisplays: selectedSkillContext.displays,
            attachedMcpSourceIds,
            semanticCapabilities,
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
            void updateRunProviderMetadata({ providerRunId: runHandle });
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
        missingProviderSession &&
        (await expireTurnProviderSession(output.error ?? 'missing session'))
      ) {
        resumeExternalSessionId = undefined;
        output = await invokeAgent({
          memoryContextBlock,
          ...(firstModel ? { model: firstModel } : {}),
        });
      }
      output = await runFamilyFailoverLoop({
        candidates: failoverCandidates,
        initialOutput: output,
        fallbackProviderId: executionProviderId,
        agentHarness,
        hasStreamedOutput: () => (streamedResult.snapshot()?.length ?? 0) > 0,
        invoke: (model) => invokeAgent({ memoryContextBlock, model }),
        onFailover: (toProviderId, details) => {
          const fromProviderId = executionProviderId;
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
        if (isStoppedByRequest(output)) {
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
        logger.error(
          { group: group.name, error: redactRuntimeError(output.error) },
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
