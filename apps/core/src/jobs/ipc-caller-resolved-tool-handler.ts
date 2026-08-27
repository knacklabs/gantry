import { randomUUID } from 'node:crypto';

import { requestCallerResolvedTool } from '../application/interactions/caller-resolved-tool-coordinator.js';
import { isAsyncTaskTerminal } from '../domain/ports/async-tasks.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { delegatedTaskAgentInScope } from './async-command-task-helpers.js';
import { taskScope } from './ipc-agent-task-lifecycle-handlers.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import {
  grantAsyncCommandBrowserHost,
  readAsyncCommandSandboxPolicy,
} from '../runtime/async-command-sandbox-policy.js';
import { parseDeclaredNetworkHost } from '../shared/network-host-declaration.js';
import { jobArtifactScope } from '../domain/ports/job-semantic-checkpoints.js';
import type { FileArtifactId } from '../domain/file-artifacts/file-artifact.js';
import { bindWebsiteRecipeHumanIdentity } from './website-recipe-identity-binding.js';

export { bindWebsiteRecipeHumanIdentity } from './website-recipe-identity-binding.js';

const WEBSITE_RECIPE_HUMAN_TOOL = 'website_recipe_request_human';
const WEBSITE_RECIPE_COMPLETION_GATE = 'validate_website_recipe_completion';
const WEBSITE_RECIPE_HUMAN_TIMEOUT_MS = 30 * 60_000;
const REQUIRED_AUTOMATIC_CAPTCHA_ATTEMPTS = 4;
const TERMINAL_WEBSITE_RECIPE_REVIEW_SAFE_PHASES = new Set([
  'needs_review_dsl_capability_gap',
  'needs_review_authentication_required',
  'needs_review_policy_blocked',
  'needs_review_administrator_decision_required',
  'needs_review_runtime_exhausted',
  'needs_review_proof_incomplete',
]);

const budgets = new Map<
  string,
  { total: number; scopes: Map<string, number> }
>();

export function resolveCallerResolvedRunId(input: {
  runId?: string;
  parentTaskId?: string;
  sandboxRunId?: string;
  parentTaskRunId?: string | null;
}): string | undefined {
  const direct = input.runId?.trim();
  if (direct) return direct;
  if (!input.parentTaskId?.trim()) return undefined;
  return (
    input.sandboxRunId?.trim() || input.parentTaskRunId?.trim() || undefined
  );
}

export const callerResolvedToolTaskHandler: TaskHandler = async (context) => {
  const responder = createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
  const parentTaskId = toTrimmedString(context.data.parentTaskId, {
    maxLen: 160,
  });
  const parentTask = parentTaskId
    ? await context.deps.getAsyncTaskRepository?.()?.getTask(parentTaskId)
    : null;
  const inheritedRunId = parentTaskId
    ? readAsyncCommandSandboxPolicy({
        sourceAgentFolder: context.sourceAgentFolder,
        runHandle: context.data.runHandle,
      })?.runId
    : undefined;
  const runId = resolveCallerResolvedRunId({
    runId: context.data.runId,
    parentTaskId,
    sandboxRunId: inheritedRunId,
    parentTaskRunId: parentTask?.parentRunId,
  });
  const scopedContext =
    runId && !context.data.runId
      ? { ...context, data: { ...context.data, runId } }
      : context;
  const scope = taskScope(scopedContext);
  if (!scope || !runId) {
    responder.reject(
      'Caller-resolved tools require an active run.',
      'forbidden',
    );
    return;
  }
  if (
    parentTaskId &&
    (!parentTask ||
      parentTask.kind !== 'delegated_agent' ||
      parentTask.appId !== scope.appId ||
      !delegatedTaskAgentInScope(parentTask, scope.agentId) ||
      parentTask.conversationId !== scope.conversationId ||
      (parentTask.privateCorrelationJson.providerAccountId ?? null) !==
        (scope.providerAccountId ?? null) ||
      (parentTask.threadId ?? null) !== (scope.threadId ?? null) ||
      isAsyncTaskTerminal(parentTask.status))
  ) {
    responder.reject(
      'Parent delegated task is not active in this scope.',
      'forbidden',
    );
    return;
  }
  const job = context.data.jobId
    ? await context.deps.opsRepository.getJobById(context.data.jobId)
    : null;
  const config = context.data.jobId
    ? job?.agent_task?.callerResolvedTools
    : scope.sandboxPolicy.callerResolvedTools;
  const sessionId = context.data.jobId
    ? job?.session_id
    : scope.sandboxPolicy.callerResolvedTools?.sessionId;
  const toolName = toTrimmedString(context.data.payload?.toolName, {
    maxLen: 80,
  });
  const rawToolInput = context.data.payload?.toolInput ?? {};
  const toolInput =
    toolName === WEBSITE_RECIPE_HUMAN_TOOL
      ? bindWebsiteRecipeHumanIdentity(rawToolInput, job?.prompt)
      : rawToolInput;
  const definition = config?.tools.find((tool) => tool.name === toolName);
  if (!config || !sessionId || !toolName) {
    responder.reject(
      'Caller-resolved tool is not declared by this run.',
      'forbidden',
    );
    return;
  }

  const taskKey =
    (typeof parentTask?.privateCorrelationJson.taskKey === 'string'
      ? parentTask.privateCorrelationJson.taskKey
      : null) ?? 'parent';
  const isCompletionGate =
    !parentTaskId && job?.agent_task?.completionGate?.toolName === toolName;
  const activeSandboxPolicy = context.data.runHandle
    ? readAsyncCommandSandboxPolicy({
        sourceAgentFolder: context.sourceAgentFolder,
        runHandle: context.data.runHandle,
      })
    : undefined;
  const usesInteractionBudget = callerResolvedToolUsesInteractionBudget(
    toolName,
    activeSandboxPolicy?.browserPolicy,
  );
  if (!definition && !isCompletionGate) {
    responder.reject(
      'Caller-resolved tool is not declared by this run.',
      'forbidden',
    );
    return;
  }
  if (
    isCompletionGate &&
    toolName === WEBSITE_RECIPE_COMPLETION_GATE &&
    context.data.jobId
  ) {
    const checkpointRepository =
      context.deps.getJobSemanticCheckpointRepository?.();
    if (!checkpointRepository) {
      responder.reject(
        'Durable job checkpoints are unavailable.',
        'unavailable',
      );
      return;
    }
    const checkpoint = await checkpointRepository.getLatestCheckpoint({
      appId: scope.appId,
      agentId: memoryAgentIdForWorkspaceFolder(context.sourceAgentFolder),
      jobId: context.data.jobId,
    });
    const evaluatorResultStatus = checkpoint?.payload.evaluatorInvocationRef
      ? await websiteRecipeEvaluatorResultStatus({
          repository: context.deps.getAsyncTaskRepository?.(),
          appId: scope.appId,
          agentId: memoryAgentIdForWorkspaceFolder(context.sourceAgentFolder),
          jobId: context.data.jobId,
          evaluatorInvocationRef: checkpoint.payload.evaluatorInvocationRef,
        })
      : undefined;
    responder.acceptData(
      'Website recipe completion checked.',
      websiteRecipeCompletionDecision(
        checkpoint?.milestone,
        checkpoint?.sequence,
        checkpoint?.payload.safePhase,
        evaluatorResultStatus,
      ),
    );
    return;
  }
  if (toolName === WEBSITE_RECIPE_HUMAN_TOOL && context.data.jobId) {
    const checkpointRepository =
      context.deps.getJobSemanticCheckpointRepository?.();
    if (!checkpointRepository) {
      responder.reject(
        'Durable job checkpoints are unavailable.',
        'unavailable',
      );
      return;
    }
    const checkpoint = await checkpointRepository.getLatestCheckpoint({
      appId: scope.appId,
      agentId: memoryAgentIdForWorkspaceFolder(context.sourceAgentFolder),
      jobId: context.data.jobId,
    });
    if (!recipeHumanWaitCheckpointReady(checkpoint?.milestone)) {
      responder.acceptData('Human assistance was not requested.', {
        status: 'checkpoint_required',
        retryable: true,
        requiredMilestone: 'human_wait',
        latestCheckpoint: checkpoint
          ? {
              id: checkpoint.id,
              sequence: checkpoint.sequence,
              milestone: checkpoint.milestone,
            }
          : null,
        nextAction:
          'Save a human_wait semantic checkpoint, then call website_recipe_request_human again.',
      });
      return;
    }
    if (
      recipeOriginAlreadyAllowed(
        toolInput,
        job?.agent_task?.browserAllowedNetworkHosts ?? [],
      )
    ) {
      responder.acceptData('Human assistance was not requested.', {
        status: 'captcha_interaction_required',
        retryable: true,
        nextAction:
          'The requested origin is already approved. If a CAPTCHA is blocking progress, request type captcha with the fresh challenge and fourth automatic-attempt evidence; do not request origin permission again.',
      });
      return;
    }
    if (record(toolInput).type === 'captcha') {
      const evidenceError = await validateFreshCaptchaEvidence({
        context,
        appId: scope.appId,
        jobId: context.data.jobId,
        runId,
        toolInput,
        captchaChallengeId:
          typeof context.data.payload?.captchaChallengeId === 'string'
            ? context.data.payload.captchaChallengeId
            : '',
      });
      if (evidenceError) {
        responder.acceptData('Human assistance was not requested.', {
          status: 'fresh_captcha_required',
          retryable: true,
          nextAction: evidenceError,
        });
        return;
      }
    }
  }
  const budgetKey = `${scope.appId}:${runId}`;
  const used = budgets.get(budgetKey) ?? {
    total: 0,
    scopes: new Map<string, number>(),
  };
  const scopeUsed = used.scopes.get(taskKey) ?? 0;
  const scopeLimit = config.maxInteractions;
  const totalLimit = config.maxInteractions;
  if (
    !isCompletionGate &&
    usesInteractionBudget &&
    (used.total >= totalLimit || scopeUsed >= scopeLimit)
  ) {
    responder.reject(
      'Caller-resolved tool budget exhausted.',
      'tool_budget_exhausted',
    );
    return;
  }
  if (!isCompletionGate && usesInteractionBudget) {
    used.total += 1;
    used.scopes.set(taskKey, scopeUsed + 1);
    budgets.set(budgetKey, used);
  }

  const requestedInteractionId =
    toTrimmedString(context.data.payload?.interactionId, { maxLen: 128 }) ?? '';
  const interactionId = /^interaction_[0-9a-f-]{36}$/iu.test(
    requestedInteractionId,
  )
    ? requestedInteractionId
    : `interaction_${randomUUID()}`;
  const interactionTimeoutMs =
    toolName === WEBSITE_RECIPE_HUMAN_TOOL
      ? Math.max(config.interactionTimeoutMs, WEBSITE_RECIPE_HUMAN_TIMEOUT_MS)
      : config.interactionTimeoutMs;
  try {
    const result = await requestCallerResolvedTool({
      appId: scope.appId,
      runId,
      sourceAgentFolder: context.sourceAgentFolder,
      sessionId,
      interactionId,
      toolName,
      toolInput,
      timeoutMs: interactionTimeoutMs,
      signal: new AbortController().signal,
      emitRequired: async () => {
        await context.deps.publishRuntimeEvent?.({
          appId: scope.appId as never,
          agentId: scope.agentId as never,
          sessionId: sessionId as never,
          runId: runId as never,
          ...(context.data.jobId ? { jobId: context.data.jobId as never } : {}),
          conversationId: scope.conversationId as never,
          ...(scope.threadId ? { threadId: scope.threadId as never } : {}),
          eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
          actor: 'gantry-runtime',
          payload: {
            interactionType: 'caller_resolved_tool',
            interactionId,
            toolName,
            input: toolInput,
            taskKey,
            expiresInMs: interactionTimeoutMs,
          },
        });
      },
    });
    if (
      toolName === WEBSITE_RECIPE_HUMAN_TOOL &&
      context.data.jobId &&
      context.data.runHandle
    ) {
      const host = approvedRecipeOriginHost({
        request: toolInput,
        resolution: result,
      });
      if (host) {
        const activePolicy = readAsyncCommandSandboxPolicy({
          sourceAgentFolder: context.sourceAgentFolder,
          runHandle: context.data.runHandle,
        });
        if (
          activePolicy?.browserPolicy !== 'recipe_authoring' ||
          activePolicy.jobId !== context.data.jobId ||
          activePolicy.runId !== runId
        ) {
          throw new Error(
            'Recipe origin grant no longer matches the active run.',
          );
        }
        const currentJob = await context.deps.opsRepository.getJobById(
          context.data.jobId,
        );
        if (!currentJob?.agent_task) {
          throw new Error('Recipe origin grant job is no longer available.');
        }
        const browserAllowedNetworkHosts = [
          ...new Set([
            ...(currentJob.agent_task.browserAllowedNetworkHosts ?? []),
            host,
          ]),
        ];
        await context.deps.opsRepository.updateJob(currentJob.id, {
          agent_task: {
            ...currentJob.agent_task,
            browserAllowedNetworkHosts,
          },
        });
        if (
          !grantAsyncCommandBrowserHost({
            sourceAgentFolder: context.sourceAgentFolder,
            runHandle: context.data.runHandle,
            jobId: currentJob.id,
            runId,
            host,
          })
        ) {
          throw new Error(
            'Recipe origin grant no longer matches the active run.',
          );
        }
      }
    }
    responder.acceptData('Caller-resolved tool completed.', result);
  } catch (error) {
    responder.reject(
      error instanceof Error ? error.message : String(error),
      'caller_tool_failed',
    );
  }
};

export function websiteRecipeCompletionDecision(
  milestone?: string,
  sequence?: number,
  safePhase?: string,
  evaluatorResultStatus?: string,
):
  | { decision: 'accept'; progressToken: string }
  | { decision: 'continue'; progressToken: string; message: string } {
  const progressToken = `checkpoint:${sequence ?? 0}:${milestone ?? 'none'}`;
  if (
    milestone === 'needs_review' &&
    safePhase === 'human_interaction_retry_required'
  ) {
    return {
      decision: 'continue',
      progressToken,
      message:
        'The latest CAPTCHA answer did not clear the gate and a fresh challenge was captured. This is a resumable human_interaction_retry_required phase, not a terminal needs_review conclusion. Continue the same workflow by running the typed automatic CAPTCHA loop against the fresh challenge before requesting any new human fallback.',
    };
  }
  if (
    milestone === 'needs_review' &&
    (safePhase === 'human_wait' || safePhase === 'captcha_human_wait')
  ) {
    return {
      decision: 'continue',
      progressToken,
      message:
        'The latest checkpoint describes a human-wait phase but does not contain the atomic human_wait milestone and pendingInteractionRef required to pause safely. Do not return terminal needs_review JSON. Save milestone="human_wait" with the typed humanInteraction CAPTCHA payload so the administrator can answer the fresh challenge and this same job can resume.',
    };
  }
  if (
    milestone === 'evaluation_analyzed' &&
    /compile_(?:blocked|rejected|transport)/u.test(safePhase ?? '')
  ) {
    return {
      decision: 'continue',
      progressToken,
      message:
        'Compilation rejection is a repairable agent step, not a terminal evaluation result. Continue from the retained candidate and evidence. Rebuild the typed observation inventory with version="website_recipe.observation_inventory@1", a stable non-empty agent-chosen surfaceId, the websiteSnapshot.websiteSnapshotSha256, and exactly the listing, pagination, detail, documents, and captcha claims. Call recipe_compile with a binding whose surfaceId matches the inventory, whose recipeVersionId is a stable non-empty agent-chosen value, and whose snapshot hash, configuration revision, start URL, and parameter values come from INPUT_JSON. Repair and retry until compilation succeeds or Gantry exhausts total runtime.',
    };
  }
  if (
    milestone === 'evaluation_analyzed' &&
    evaluatorResultStatus !== 'proven'
  ) {
    return {
      decision: 'continue',
      progressToken,
      message:
        evaluatorResultStatus === 'failed'
          ? 'The real-scraper evaluator returned a failed result. Inspect its missing requirement IDs, trace, explanations, and sample records. If they support a material candidate or compiler-bound test-plan repair, make that change, compile again, and resubmit in this same durable job. A new checkpoint or idempotency key alone is not a repair. If the retained evidence proves no justified material repair is available, save milestone="needs_review" with safePhase="needs_review_proof_incomplete" and explain the missing coverage, activation risk, and recommended administrator action. Continue until the evaluator returns status="proven" or that explicit non-repairable boundary is durably recorded.'
          : 'Evaluation completion is not proven by the durable external evaluator result. Do not finalize the job. Recover or resubmit the evaluator invocation in this same durable job, then analyze its typed result. Only evaluator status="proven" may complete evaluation_analyzed.',
    };
  }
  if (
    milestone === 'needs_review' &&
    !TERMINAL_WEBSITE_RECIPE_REVIEW_SAFE_PHASES.has(safePhase ?? '')
  ) {
    return {
      decision: 'continue',
      progressToken,
      message:
        'Plain needs_review is not a terminal recipe outcome. The latest checkpoint remains repairable or does not contain a typed non-repairable reason. Continue from its retained artifacts and next action: compile or repair the candidate, create a compiler-backed test plan, and submit real-scraper evaluation in this same durable job. Only a genuine non-repairable boundary may use needs_review with one of these safePhase values: needs_review_dsl_capability_gap, needs_review_authentication_required, needs_review_policy_blocked, needs_review_administrator_decision_required, needs_review_runtime_exhausted, or needs_review_proof_incomplete.',
    };
  }
  if (milestone === 'evaluation_analyzed' || milestone === 'needs_review') {
    return { decision: 'accept', progressToken };
  }
  if (milestone !== 'human_wait') {
    return {
      decision: 'continue',
      progressToken,
      message: `The latest durable milestone is ${milestone ?? 'none'}, which is not terminal. Continue the same agent-driven workflow from this checkpoint until evaluation is analyzed, a supported needs_review conclusion is durably recorded, or Gantry itself exhausts the configured cumulative runtime. A per-turn runtime_boundary is a resumable checkpoint, never a terminal result. If administrator assistance is required, create it atomically with job_checkpoint_save milestone="human_wait" and humanInteraction; there is no separate human-request tool.`,
    };
  }
  return {
    decision: 'continue',
    progressToken,
    message:
      'The latest durable milestone is human_wait. Do not return terminal JSON or repeat browser exploration. A non-empty pendingInteractionRef proves the atomic humanInteraction contract was used; raw humanInteraction arguments are deliberately not retained in checkpoint payloads. Only a human_wait checkpoint without pendingInteractionRef predates the atomic contract and requires administrator clean rebuild.',
  };
}

async function websiteRecipeEvaluatorResultStatus(input: {
  repository:
    | ReturnType<
        NonNullable<
          Parameters<TaskHandler>[0]['deps']['getAsyncTaskRepository']
        >
      >
    | undefined;
  appId: string;
  agentId: string;
  jobId: string;
  evaluatorInvocationRef: string;
}): Promise<string | undefined> {
  if (!input.repository) return undefined;
  const tasks = await input.repository.listTasks({
    appId: input.appId,
    agentId: input.agentId,
    kind: 'external_capability',
    parentJobId: input.jobId,
    order: 'newest_first',
    limit: 100,
  });
  const task = tasks.find((candidate) => {
    if (
      candidate.authoritySnapshotJson.capabilityId !==
        'manipal.website-recipe-evaluator@1' ||
      candidate.authoritySnapshotJson.operation !== 'evaluation_submit'
    ) {
      return false;
    }
    return (
      candidate.privateCorrelationJson.invocationRef ===
        input.evaluatorInvocationRef ||
      candidate.privateCorrelationJson.resultRef ===
        input.evaluatorInvocationRef
    );
  });
  const result = record(task?.privateCorrelationJson.result);
  return result.version === 'website_recipe.evaluation.result@1' &&
    typeof result.status === 'string'
    ? result.status
    : undefined;
}

async function validateFreshCaptchaEvidence(input: {
  context: Parameters<TaskHandler>[0];
  appId: string;
  jobId: string;
  runId: string;
  toolInput: unknown;
  captchaChallengeId: string;
}): Promise<string | null> {
  const artifactIds = strings(record(input.toolInput).evidenceRefs).filter(
    (ref) => /^file-artifact:[0-9a-f-]{36}$/iu.test(ref),
  );
  const attemptArtifactId =
    typeof record(input.toolInput).automaticAttemptEvidenceRef === 'string'
      ? String(record(input.toolInput).automaticAttemptEvidenceRef)
      : '';
  const store = input.context.deps.getFileArtifactStore?.();
  const run = await input.context.deps.opsRepository.getJobRunById(input.runId);
  if (
    artifactIds.length === 0 ||
    !/^file-artifact:[0-9a-f-]{36}$/iu.test(attemptArtifactId) ||
    !store ||
    !run
  )
    return freshCaptchaInstruction();
  try {
    const agentId = memoryAgentIdForWorkspaceFolder(
      input.context.sourceAgentFolder,
    );
    const [
      evidence,
      { artifact: attemptArtifact, content: attemptContent },
      challengeEntry,
    ] = await Promise.all([
      Promise.all(
        artifactIds.map((artifactId) =>
          store
            .readFileArtifact({
              id: artifactId as FileArtifactId,
              appId: input.appId,
              agentId,
            })
            .catch(() => null),
        ),
      ),
      store.readFileArtifact({
        id: attemptArtifactId as FileArtifactId,
        appId: input.appId,
        agentId,
      }),
      /^captcha_[0-9a-f-]{36}$/iu.test(input.captchaChallengeId)
        ? store
            .readFileArtifact({
              appId: input.appId,
              agentId,
              virtualScope: jobArtifactScope(input.jobId),
              virtualPath: `captcha-challenge/${input.captchaChallengeId}.json`,
            })
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    const attempt = parseCaptchaAttempt(attemptContent);
    const challenge = challengeEntry
      ? parseCaptchaChallengeEvidence(challengeEntry.content)
      : null;
    const requestedFingerprint =
      typeof record(input.toolInput).challengeFingerprint === 'string'
        ? String(record(input.toolInput).challengeFingerprint)
        : '';
    const captchaEvidence = evidence.find(
      (entry) =>
        entry !== null &&
        challenge !== null &&
        entry.artifact.id === challenge.screenshotEvidenceRef &&
        entry.artifact.virtualScope === jobArtifactScope(input.jobId) &&
        entry.artifact.virtualPath.startsWith('captcha/captcha_') &&
        entry.artifact.virtualPath.endsWith('.png') &&
        entry.artifact.contentType === 'image/png' &&
        Date.parse(entry.artifact.createdAt) >= Date.parse(run.started_at) &&
        isUsableCaptchaPng(entry.content),
    );
    if (
      !captchaEvidence ||
      !challenge ||
      challenge.automaticAttemptEvidenceRef !== attemptArtifactId ||
      challenge.challengeFingerprint !== requestedFingerprint ||
      attemptArtifact.virtualScope !== jobArtifactScope(input.jobId) ||
      !attemptArtifact.virtualPath.startsWith('captcha-attempt/captcha_') ||
      attemptArtifact.contentType !== 'application/json' ||
      Date.parse(attemptArtifact.createdAt) < Date.parse(run.started_at) ||
      !attempt ||
      attempt.attemptNumber < REQUIRED_AUTOMATIC_CAPTCHA_ATTEMPTS
    ) {
      return freshCaptchaInstruction();
    }
    return null;
  } catch {
    return freshCaptchaInstruction();
  }
}

function parseCaptchaChallengeEvidence(content: Uint8Array | string): {
  screenshotEvidenceRef: string;
  automaticAttemptEvidenceRef: string;
  challengeFingerprint: string;
} | null {
  try {
    const value = JSON.parse(
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8'),
    ) as Record<string, unknown>;
    return typeof value.screenshotEvidenceRef === 'string' &&
      typeof value.automaticAttemptEvidenceRef === 'string' &&
      typeof value.challengeFingerprint === 'string'
      ? {
          screenshotEvidenceRef: value.screenshotEvidenceRef,
          automaticAttemptEvidenceRef: value.automaticAttemptEvidenceRef,
          challengeFingerprint: value.challengeFingerprint,
        }
      : null;
  } catch {
    return null;
  }
}

export function isFreshCaptchaScreenshotForAttempt(input: {
  screenshotPath: string;
  screenshotCreatedAt: string;
  attemptCreatedAt: string;
  runStartedAt: string;
  attemptChallengeId: string;
  attemptOutcome: 'submitted' | 'inconclusive';
}): boolean {
  const screenshotAt = Date.parse(input.screenshotCreatedAt);
  const attemptAt = Date.parse(input.attemptCreatedAt);
  const runStartedAt = Date.parse(input.runStartedAt);
  if (![screenshotAt, attemptAt, runStartedAt].every(Number.isFinite))
    return false;
  if (screenshotAt >= attemptAt) return true;
  return (
    input.attemptOutcome === 'inconclusive' &&
    input.screenshotPath === `captcha/${input.attemptChallengeId}.png` &&
    screenshotAt >= runStartedAt
  );
}

function parseCaptchaAttempt(content: Uint8Array | string): {
  challengeId: string;
  outcome: 'submitted' | 'inconclusive';
  attemptNumber: number;
} | null {
  try {
    const value = JSON.parse(
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8'),
    ) as Record<string, unknown>;
    return typeof value.challengeId === 'string' &&
      (value.outcome === 'submitted' || value.outcome === 'inconclusive') &&
      Number.isInteger(value.attemptNumber) &&
      Number(value.attemptNumber) > 0
      ? {
          challengeId: value.challengeId,
          outcome: value.outcome,
          attemptNumber: Number(value.attemptNumber),
        }
      : null;
  } catch {
    return null;
  }
}

export function isUsableCaptchaPng(content: Uint8Array | string): boolean {
  const bytes =
    typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
  return (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(16) >= 64 &&
    bytes.readUInt32BE(20) >= 20
  );
}

function freshCaptchaInstruction(): string {
  return `Make up to ${REQUIRED_AUTOMATIC_CAPTCHA_ATTEMPTS} typed automatic vision-and-submit attempts with browser_captcha_challenge, verifying the gate after each attempt. Do not decode the image or call browser_captcha_settle during automatic attempts. If an attempt fails, recapture the refreshed challenge before retrying. Human fallback is allowed only after attempt ${REQUIRED_AUTOMATIC_CAPTCHA_ATTEMPTS}, using the fresh screenshot and final Automatic CAPTCHA attempt evidence reference. Use browser_captcha_settle only after the authorized human answer resumes this same session. Checkpoint evidence from an earlier run cannot be used.`;
}

export function callerResolvedToolUsesInteractionBudget(
  toolName: string | undefined,
  browserPolicy: string | undefined,
): boolean {
  return !(
    toolName === WEBSITE_RECIPE_HUMAN_TOOL &&
    browserPolicy === 'recipe_authoring'
  );
}

export function recipeHumanWaitCheckpointReady(
  milestone: string | undefined,
): boolean {
  return milestone === 'human_wait';
}

export function approvedRecipeOriginHost(input: {
  request: unknown;
  resolution: unknown;
}): string | null {
  const request = record(input.request);
  const resolution = record(input.resolution);
  if (request.type !== 'origin' || resolution.approved !== true) return null;
  const requestedScope = record(request.permissionScope);
  const resolvedScope = record(resolution.permissionScope);
  const origin =
    typeof requestedScope.origin === 'string'
      ? requestedScope.origin.trim()
      : '';
  if (!origin || resolvedScope.origin !== origin) {
    throw new Error(
      'Recipe origin approval must match the requested exact origin.',
    );
  }
  const requestedMethods = strings(requestedScope.methods);
  const resolvedMethods = strings(resolvedScope.methods);
  if (
    resolvedMethods.length === 0 ||
    resolvedMethods.some(
      (method) =>
        !requestedMethods.includes(method) || !['GET', 'HEAD'].includes(method),
    )
  ) {
    throw new Error(
      'Recipe origin approval permits only requested GET or HEAD methods.',
    );
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Recipe origin approval contains an invalid origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.username ||
    url.password
  ) {
    throw new Error('Recipe origin approval requires an exact HTTPS origin.');
  }
  const parsed = parseDeclaredNetworkHost(
    `${url.hostname}${url.port ? `:${url.port}` : ''}`,
  );
  if (!parsed.ok) throw new Error(`Recipe origin approval ${parsed.reason}`);
  return parsed.host;
}

export function recipeOriginAlreadyAllowed(
  toolInput: unknown,
  allowedHosts: readonly string[],
): boolean {
  const request = record(toolInput);
  if (request.type !== 'origin') return false;
  const origin = record(request.permissionScope).origin;
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    const parsed = parseDeclaredNetworkHost(
      `${url.hostname}${url.port ? `:${url.port}` : ''}`,
    );
    return parsed.ok && allowedHosts.includes(parsed.host);
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
