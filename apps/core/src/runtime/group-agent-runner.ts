import type { ConversationRoute } from '../domain/types.js';
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
import { createRuntimeModelStatusAccess } from './model-status-store.js';
import { recordRuntimeModelUsage } from './model-status-output.js';
import {
  buildProviderSessionAccessFingerprint,
  providerSessionAccessFingerprintMatches,
} from './provider-session-access-fingerprint.js';
import { buildBoundedMemoryRecallQuery } from '../memory/app-memory-recall-query.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { isRuntimeEventType } from '../domain/events/runtime-event-types.js';
import { resolveRuntimeExecutionProviderId } from './execution-provider-id.js';
import { resolveExecutionRoute } from '../shared/model-execution-route.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { appIdFromConversationJid } from '../shared/app-conversation-jid.js';
import {
  executionProviderIdForCandidate,
  resolveTurnFailoverCandidates,
  runFamilyFailoverLoop,
  publishRunFailoverEvent,
} from './failover-candidate-loop.js';
import { logger, redactString } from '../infrastructure/logging/logger.js';
const DEFAULT_ASSISTANT_NAME = 'Gantry';
const DEFAULT_MODEL_ALIAS = 'opus';
const DEFAULT_TURN_APP_ID = 'default';
const MEMORY_REVIEW_APPROVER_CACHE_TTL_MS = 60_000;
const WORKSPACE_FOLDER_INPUT_KEY = `workspace${'Folder'}`;
const memoryReviewApproverCache = new Map<string, [boolean, number]>();

export type GroupAgentRunResult = 'success' | 'error' | 'stopped';

function isMissingProviderSessionError(error: string | undefined): boolean {
  return /\bprovider session\b.*\b(?:missing|expired|not found)\b/i.test(
    error ?? '',
  );
}

function redactRuntimeError(error: string | undefined): string | undefined {
  return error ? redactString(error) : undefined;
}

function isStoppedByRequest(output: AgentOutput): boolean {
  return (
    output.status === 'error' &&
    /\bstopped by request\b/i.test(output.error ?? '')
  );
}
function runtimeEventDedupKey(input: {
  eventType: string;
  appId?: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
  conversationId?: string;
  threadId?: string | null;
  payload: unknown;
}): string {
  let payload: string;
  try {
    payload = JSON.stringify(input.payload) ?? 'undefined';
  } catch {
    payload = String(input.payload);
  }
  return [
    input.eventType,
    input.appId ?? '',
    input.agentId ?? '',
    input.runId ?? '',
    input.jobId ?? '',
    input.conversationId ?? '',
    input.threadId ?? '',
    payload,
  ].join('\u001f');
}

async function memoryReviewerApproverAllowed(
  deps: GroupProcessingDeps,
  conversationJid: string,
  sourceAgentFolder: string,
  userId?: string,
): Promise<boolean> {
  if (!userId) return false;
  const hook = deps.channelRuntime.isControlApproverAllowed;
  if (!hook) return false;
  const key = `${conversationJid}\0${sourceAgentFolder}\0${userId}`;
  const now = currentTimeMs();
  const cached = memoryReviewApproverCache.get(key);
  if (cached && cached[1] > now) return cached[0];
  const allowed =
    (await hook({
      conversationJid,
      userId,
      sourceAgentFolder,
      decisionPolicy: 'same_channel',
    }).catch(() => false)) === true;
  memoryReviewApproverCache.set(key, [
    allowed,
    now + MEMORY_REVIEW_APPROVER_CACHE_TTL_MS,
  ]);
  return allowed;
}
export function createGroupAgentRunner(input: {
  deps: GroupProcessingDeps;
  ops: () => GroupProcessingRepository;
}) {
  const { deps, ops } = input;
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const collectSessionMemory = deps.collectSessionMemory;
  return async function runAgent(
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
        content?: string | null;
        sender?: string | null;
        is_from_me?: boolean | null;
      }[];
      existingRunId?: string;
      existingRunLeaseToken?: string;
      existingRunLeaseWorkerInstanceId?: string;
      existingRunLeaseFencingVersion?: number;
    },
  ): Promise<GroupAgentRunResult> {
    const initialModelSelection = defaultModelStatusSelection(
      group.agentConfig?.model ?? DEFAULT_MODEL_ALIAS,
    );
    const agentHarness = deps.getSelectedAgentHarness(group.folder);
    const turnAppId = appIdFromConversationJid(chatJid) ?? DEFAULT_TURN_APP_ID;
    // Configured-first model-family failover candidates for THIS turn. [] means
    // no override (keep pre-failover behavior); candidates[0] is the existing
    // single-rewrite default, passed as the model so spawn uses that member.
    //
    // This must happen before session/turn context lookup: family aliases do
    // not resolve through defaultModelStatusSelection(), so provider-session
    // lookup has to be keyed by the first concrete candidate's execution lane.
    const failoverCandidates = await resolveTurnFailoverCandidates({
      requestedModel: group.agentConfig?.model,
      appId: turnAppId,
      listConfiguredProviders: deps.getConfiguredModelProviders,
      familyOrder: deps.getModelFamilyOrder?.(),
    });
    const firstModel = failoverCandidates[0];
    const fallbackExecutionProviderId = (): ExecutionProviderId =>
      resolveRuntimeExecutionProviderId(
        deps.executionAdapter,
      ) as ExecutionProviderId;
    // Live-turn lease execution provider must match the runner's engine-resolved
    // route. The engine is derived from the resolved model's provider.
    const liveTurnRoute = initialModelSelection.model
      ? resolveExecutionRoute({
          entry: initialModelSelection.model,
          agentHarness,
        })
      : undefined;
    // Per-candidate during model-family failover: starts at the chat-default
    // model's provider and is reassigned to the active candidate's provider when
    // a failover advances. Closures below capture this binding by reference so
    // provider-session persistence/expiry follow the candidate actually running.
    let executionProviderId = firstModel
      ? executionProviderIdForCandidate(firstModel, undefined, agentHarness)
      : liveTurnRoute?.ok
        ? (liveTurnRoute.value.executionProviderId as ExecutionProviderId)
        : fallbackExecutionProviderId();
    const sessionThreadId = options?.memoryContext?.threadId ?? null;
    const modelStatus = createRuntimeModelStatusAccess(
      group.folder,
      sessionThreadId,
    );
    const streamedResult = createRuntimeResultSummaryAccumulator();
    const turnContext = await ops().getAgentTurnContext?.({
      appId: turnAppId,
      agentFolder: group.folder,
      executionProviderId,
      conversationJid: chatJid,
      threadId: sessionThreadId,
      conversationKind: group.conversationKind,
      memoryUserId: options?.memoryContext?.userId,
      hydrationMode: 'first_visible',
      query:
        options?.memoryContext?.source === 'message'
          ? buildBoundedMemoryRecallQuery(options.memoryContext.recallQuery)
          : undefined,
    });
    const runtimeAppId = turnContext?.appId ?? turnAppId;
    let defaultRuntimeModel: string | undefined;
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
    let resumeProviderSessionId = turnContext?.providerSessionId ?? undefined;
    let resumeExternalSessionId = turnContext?.externalSessionId ?? undefined;
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
    const forwardRuntimeEvents = async (output: AgentOutput) => {
      if (output.runtimeEvents?.length && deps.publishRuntimeEvent) {
        for (const event of output.runtimeEvents) {
          if (!isRuntimeEventType(event.eventType)) continue;
          const appId = event.appId ?? runtimeAppId;
          if (!appId) continue;
          const eventKey = runtimeEventDedupKey({
            eventType: event.eventType,
            appId,
            agentId: event.agentId ?? turnContext?.agentId,
            runId: event.runId ?? runState.runId,
            jobId: event.jobId,
            conversationId: event.conversationId ?? chatJid,
            threadId: event.threadId ?? sessionThreadId,
            payload: event.payload,
          });
          if (forwardedRuntimeEventKeys.has(eventKey)) continue;
          forwardedRuntimeEventKeys.add(eventKey);
          await deps.publishRuntimeEvent({
            appId: appId as never,
            ...((event.agentId ?? turnContext?.agentId)
              ? {
                  agentId: (event.agentId ?? turnContext?.agentId) as never,
                }
              : {}),
            ...((event.runId ?? runState.runId)
              ? { runId: (event.runId ?? runState.runId) as never }
              : {}),
            ...(event.jobId ? { jobId: event.jobId as never } : {}),
            conversationId: (event.conversationId ?? chatJid) as never,
            ...((event.threadId ?? sessionThreadId)
              ? {
                  threadId: (event.threadId ?? sessionThreadId) as never,
                }
              : {}),
            eventType: event.eventType,
            actor: event.actor ?? 'runner',
            responseMode: event.responseMode ?? 'none',
            payload: event.payload,
          });
        }
      }
    };
    const wrappedOnOutput = async (output: AgentOutput) => {
      await persistProviderSessionFromOutput(output);
      if (output.usage) {
        recordRuntimeModelUsage({
          group,
          threadId: sessionThreadId,
          usage: output.usage,
          usageEventId: output.usageEventId,
          getDefaultModel: () => {
            defaultRuntimeModel ??=
              group.agentConfig?.model ?? DEFAULT_MODEL_ALIAS;
            return defaultRuntimeModel;
          },
        });
      }
      if (output.contextUsage) {
        modelStatus.updateSelection({
          ...defaultModelStatusSelection(
            group.agentConfig?.model ??
              (defaultRuntimeModel ??=
                group.agentConfig?.model ?? DEFAULT_MODEL_ALIAS),
          ),
          selectionSource: group.agentConfig?.model
            ? 'session override'
            : 'chat default',
          contextUsage: output.contextUsage,
        });
      }
      if (output.status !== 'error' && output.result) {
        streamedResult.append(String(output.result));
      }
      await forwardRuntimeEvents(output);
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
    const memoryContextBlock = [
      turnContext?.memoryContextBlock,
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
            prompt,
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
            ...(agentInput.resumeSessionId
              ? { sessionId: agentInput.resumeSessionId }
              : {}),
            ...(options?.existingRunId && runState.runId
              ? { runId: runState.runId }
              : {}),
            ...(options?.existingRunLeaseToken
              ? { runLeaseToken: options.existingRunLeaseToken }
              : {}),
            ...(typeof options?.existingRunLeaseFencingVersion === 'number'
              ? {
                  runLeaseFencingVersion:
                    options.existingRunLeaseFencingVersion,
                }
              : {}),
            [WORKSPACE_FOLDER_INPUT_KEY]: group.folder,
          } as Parameters<typeof runAgentImpl>[1],
          (proc, runHandle) => {
            void updateRunProviderMetadata({ providerRunId: runHandle });
            const registerOptions =
              memoryReviewerIsControlApprover && memoryReviewerUserId
                ? { requiredContinuationUserId: memoryReviewerUserId }
                : undefined;
            if (registerOptions) {
              deps.queue.registerProcess(
                queueJid,
                proc,
                runHandle,
                group.folder,
                queueJid === chatJid ? undefined : chatJid,
                options?.memoryContext?.threadId,
                registerOptions,
              );
              return;
            }
            deps.queue.registerProcess(
              queueJid,
              proc,
              runHandle,
              group.folder,
              queueJid === chatJid ? undefined : chatJid,
              options?.memoryContext?.threadId,
            );
          },
          wrappedOnOutput,
          runOptions,
        );
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
      const missingProviderSession =
        activeExecutionAdapter?.isMissingProviderSessionError?.(output.error) ??
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
      // Live model-family failover: while NO visible output has streamed and the
      // error is provider-specific, advance to the next configured candidate and
      // re-invoke with that model and NO resume id (a different provider must not
      // resume the prior provider's session). Streamed-output read fresh each iter.
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
      await forwardRuntimeEvents(output);
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
  };
}
