import type {
  GantryAgentCurrentBrowserState,
  GantryAgentMemory,
  GantryAgentTaskAttachment,
  GantryAgentTaskAttachmentRequest,
  GantryAgentTaskInput,
  GantryAgentTaskResult,
  GantryAgentTaskStep,
} from '../shared/types.js';
import { asRecord, readString } from '../shared/helpers.js';

const RAW_OBSERVATION_HISTORY_LIMIT = 6;
const SEMANTIC_OBSERVATION_HISTORY_LIMIT = 40;
const FAILED_ACTION_MEMORY_LIMIT = 80;
const COMPACTION_EVENT_LIMIT = 40;
const LARGE_OBSERVATION_CHAR_LIMIT = 8_000;
const SEMANTIC_TEXT_LIMIT = 1_200;

export function normalizeAgentMaxSteps(
  value: number | null | undefined,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1)
    return 12;
  return Math.min(100, Math.floor(value));
}

export function cloneJsonRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function resolveAgentDeadlineMs(
  deadlineAt: string | null | undefined,
): number | null {
  if (!deadlineAt) return null;
  const parsed = Date.parse(deadlineAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed - Date.now());
}

export async function runWithOptionalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | null | undefined,
  message: string,
): Promise<T> {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    return await promise;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readAgentStepAttachments(
  input: GantryAgentTaskInput,
  request: GantryAgentTaskAttachmentRequest,
): Promise<readonly GantryAgentTaskAttachment[]> {
  if (!input.getStepAttachments) return [];
  const raw = await input.getStepAttachments(request);
  return raw
    .filter(
      (attachment) =>
        attachment &&
        typeof attachment.mimeType === 'string' &&
        attachment.mimeType.trim().length > 0 &&
        (typeof attachment.base64 === 'string' ||
          typeof attachment.localPath === 'string'),
    )
    .slice(0, 4);
}

export function buildGenericAgentStepInstructions(
  input: GantryAgentTaskInput,
  step: number,
): string {
  return [
    input.instructions,
    '',
    'You are running inside a generic Gantry agent loop.',
    `Step ${step}. Choose exactly one action.`,
    'Return JSON only with one of these shapes:',
    '{"action":"call_tool","toolName":"tool_name","input":{...}}',
    '{"action":"final","output":{...}}',
    '{"action":"needs_input","reason":"..."}',
    'Every response must also include previousGoalEvaluation, memoryUpdate, and nextGoal. Treat them as the agent progress ledger: evaluate the previous goal, record durable facts/failures, and name the next concrete goal.',
    'previousGoalEvaluation shape: {"goal":"...","status":"passed|failed|partial|not_evaluated","evidenceRefs":["..."],"reason":"..."}',
    'memoryUpdate shape: {"durableFacts":{...},"failedActions":[...],"notes":["..."]}. Only include facts that should survive long runs and compaction.',
    'nextGoal shape: {"goal":"...","requiredEvidence":["..."],"recommendedTool":"tool_name_or_null"}',
    'Include concise auditNote, whyThisStep, expectedOutcome, and nextIfFails fields so operators can audit what you are doing without hidden reasoning.',
    'When screenshots or image attachments are available, also include visualSummary, visibleTarget, whyThisAction, expectedStateChange, and fallbackIfWrong.',
    'YOU MUST evaluate the previous goal against currentBrowserState before every browser action. If currentBrowserState.visualFreshness is previous, missing, or mismatch, do not trust the image as current; inspect the browser for fresh state before consequential clicks.',
    'If currentBrowserState.openSurfaces or blockingOverlay is present, target that active surface first. Do not click elements behind a modal/dialog unless your action intentionally closes it with current evidence.',
    'Use current browser state as the primary truth. Screenshots are only current when their attachment label and currentBrowserState.visualFreshness say current.',
    'Use call_tool until the task is actually complete. Use final only when the final output satisfies the task instructions.',
  ].join('\n');
}

export async function buildAgentStepInstructions(
  input: GantryAgentTaskInput,
  request: {
    readonly taskType: string;
    readonly correlationId?: string | null;
    readonly step: number;
    readonly state: Record<string, unknown>;
  },
): Promise<string> {
  const genericInstructions = buildGenericAgentStepInstructions(
    input,
    request.step,
  );
  if (!input.buildStepInstructions) return genericInstructions;
  const customInstructions = await input.buildStepInstructions(request);
  if (!customInstructions.trim()) return genericInstructions;
  return [
    genericInstructions,
    '',
    'Task-specific step guidance:',
    customInstructions,
  ].join('\n');
}

export function buildGenericAgentActionSchema(
  finalSchema?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    required: ['action', 'previousGoalEvaluation', 'memoryUpdate', 'nextGoal'],
    properties: {
      action: { type: 'string', enum: ['call_tool', 'final', 'needs_input'] },
      toolName: { type: 'string' },
      input: { type: 'object' },
      output: finalSchema ?? { type: 'object' },
      reason: { type: 'string' },
      auditNote: { type: 'string' },
      whyThisStep: { type: 'string' },
      expectedOutcome: { type: 'string' },
      nextIfFails: { type: 'string' },
      visualSummary: { type: 'string' },
      visibleTarget: { type: 'string' },
      whyThisAction: { type: 'string' },
      expectedStateChange: { type: 'string' },
      fallbackIfWrong: { type: 'string' },
      previousGoalEvaluation: {
        type: 'object',
        properties: {
          goal: { type: ['string', 'null'] },
          status: {
            type: 'string',
            enum: ['passed', 'failed', 'partial', 'not_evaluated'],
          },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
      },
      memoryUpdate: { type: 'object' },
      nextGoal: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          requiredEvidence: { type: 'array', items: { type: 'string' } },
          recommendedTool: { type: ['string', 'null'] },
        },
      },
    },
  };
}

export function parseGenericAgentAction(action: Record<string, unknown>): {
  readonly action: string;
  readonly toolName?: string | null;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown>;
  readonly reason?: string | null;
  readonly auditNote?: string | null;
  readonly whyThisStep?: string | null;
  readonly expectedOutcome?: string | null;
  readonly nextIfFails?: string | null;
  readonly visualSummary?: string | null;
  readonly visibleTarget?: string | null;
  readonly whyThisAction?: string | null;
  readonly expectedStateChange?: string | null;
  readonly fallbackIfWrong?: string | null;
  readonly previousGoalEvaluation?: Record<string, unknown> | null;
  readonly memoryUpdate?: Record<string, unknown> | null;
  readonly nextGoal?: Record<string, unknown> | null;
} {
  const actionName = readString(action, 'action') ?? '';
  return {
    action: actionName,
    toolName: readString(action, 'toolName'),
    input: asRecord(action.input) ?? {},
    output: asRecord(action.output) ?? {},
    reason: readString(action, 'reason'),
    auditNote: readString(action, 'auditNote'),
    whyThisStep: readString(action, 'whyThisStep'),
    expectedOutcome: readString(action, 'expectedOutcome'),
    nextIfFails: readString(action, 'nextIfFails'),
    visualSummary: readString(action, 'visualSummary'),
    visibleTarget: readString(action, 'visibleTarget'),
    whyThisAction: readString(action, 'whyThisAction'),
    expectedStateChange: readString(action, 'expectedStateChange'),
    fallbackIfWrong: readString(action, 'fallbackIfWrong'),
    previousGoalEvaluation: asRecord(action.previousGoalEvaluation),
    memoryUpdate: asRecord(action.memoryUpdate),
    nextGoal: asRecord(action.nextGoal),
  };
}

export function summarizeAgentObservation(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (json.length <= LARGE_OBSERVATION_CHAR_LIMIT) return value;
  return {
    compacted: true,
    originalCharCount: json.length,
    semanticSummary: extractAgentSemanticObservation(value),
    rawPreview: json.slice(0, SEMANTIC_TEXT_LIMIT),
    omittedRawCharCount: Math.max(0, json.length - SEMANTIC_TEXT_LIMIT),
  };
}

export function createInitialAgentMemory(
  input: GantryAgentTaskInput,
): GantryAgentMemory {
  const provided =
    asRecord(input.input.agentMemory) ?? asRecord(input.input.memory);
  const mainGoal =
    readString(provided, 'mainGoal') ??
    readString(input.input, 'mainGoal') ??
    input.taskType;
  const currentGoal =
    readString(provided, 'currentGoal') ?? 'start the task with evidence';
  const previousGoalEvaluation = normalizePreviousGoalEvaluation(
    asRecord(provided?.previousGoalEvaluation),
    null,
  );
  const nextGoal = normalizeNextGoal(asRecord(provided?.nextGoal), currentGoal);
  return {
    mainGoal,
    currentGoal,
    previousGoalEvaluation,
    durableFacts: {
      ...(asRecord(provided?.durableFacts) ?? {}),
      taskType: input.taskType,
      correlationId: input.correlationId ?? null,
    },
    failedActions: readFailedActions(provided?.failedActions),
    nextGoal,
    currentBrowserState: normalizeCurrentBrowserState(
      asRecord(provided?.currentBrowserState) ??
        asRecord(asRecord(provided?.durableFacts)?.currentBrowserState),
    ),
    compactionEvents: readRecordArray(provided?.compactionEvents).slice(
      -COMPACTION_EVENT_LIMIT,
    ),
  };
}

export function mergeModelProgressIntoAgentMemory(
  state: Record<string, unknown>,
  step: number,
  parsed: {
    readonly previousGoalEvaluation?: Record<string, unknown> | null;
    readonly memoryUpdate?: Record<string, unknown> | null;
    readonly nextGoal?: Record<string, unknown> | null;
  },
): void {
  const memory = ensureAgentMemory(state);
  const previousGoalEvaluation = normalizePreviousGoalEvaluation(
    parsed.previousGoalEvaluation ?? null,
    memory.currentGoal,
  );
  const memoryUpdate = parsed.memoryUpdate ?? {};
  const durableUpdate =
    asRecord(memoryUpdate.durableFacts) ?? asRecord(memoryUpdate.facts) ?? {};
  const failedActions = [
    ...memory.failedActions,
    ...readRecordArray(memoryUpdate.failedActions).map((entry) =>
      normalizeFailedAction(entry, step),
    ),
  ].slice(-FAILED_ACTION_MEMORY_LIMIT);
  const nextGoal = normalizeNextGoal(
    parsed.nextGoal ?? asRecord(memoryUpdate.nextGoal),
    memory.nextGoal.goal,
  );
  state.agentMemory = {
    ...memory,
    currentGoal: nextGoal.goal,
    previousGoalEvaluation,
    durableFacts: {
      ...memory.durableFacts,
      ...compactSemanticRecord(durableUpdate),
      latestModelProgressStep: step,
      latestMemoryNotes: compactSemanticValue(memoryUpdate.notes),
    },
    failedActions,
    nextGoal,
    currentBrowserState: normalizeCurrentBrowserState(
      asRecord(state.currentBrowserState) ??
        asRecord(memory.currentBrowserState) ??
        asRecord(memory.durableFacts.currentBrowserState),
    ),
  };
}

export function recordAgentMemoryObservation(
  state: Record<string, unknown>,
  input: {
    readonly step: number;
    readonly toolName?: string | null;
    readonly actionInput?: Record<string, unknown> | null;
    readonly observation?: Record<string, unknown> | null;
    readonly status: 'completed' | 'failed' | 'skipped';
    readonly error?: string | null;
  },
): void {
  const memory = ensureAgentMemory(state);
  const semantic = extractAgentSemanticObservation({
    step: input.step,
    toolName: input.toolName ?? null,
    input: input.actionInput ?? null,
    observation: input.observation ?? null,
    status: input.status,
    error: input.error ?? null,
  });
  const currentBrowserState = normalizeCurrentBrowserState(
    asRecord(state.currentBrowserState) ??
      asRecord(semantic.currentBrowserState) ??
      asRecord(memory.currentBrowserState) ??
      asRecord(memory.durableFacts.currentBrowserState),
  );
  const history = [
    ...readRecordArray(state.semanticObservationHistory),
    semantic,
  ].slice(-SEMANTIC_OBSERVATION_HISTORY_LIMIT);
  state.semanticObservationHistory = history;

  const reason =
    input.error ??
    readString(input.observation ?? null, 'error') ??
    readNoProgressReasonFromObservation(input.observation ?? {});
  const selectedAction =
    asRecord(semantic.selectedAction) ??
    asRecord(asRecord(semantic.pageTransition)?.selectedAction) ??
    asRecord(input.actionInput);
  const fingerprint =
    readString(selectedAction, 'fingerprint') ??
    readString(asRecord(input.actionInput?.target), 'fingerprint');
  const failedActions = Array.from(memory.failedActions);
  const noProgressObserved =
    readString(asRecord(semantic.pageTransition), 'outcome') === 'no_progress';
  if (input.status === 'failed' || reason) {
    failedActions.push(
      normalizeFailedAction(
        {
          step: input.step,
          toolName: input.toolName ?? null,
          fingerprint: fingerprint ?? null,
          reason: reason ?? 'agent_step_failed',
          retryPolicy:
            noProgressObserved || reason?.includes('no_progress')
              ? 'do_not_repeat'
              : 'retry_after_new_evidence',
        },
        input.step,
      ),
    );
  }

  state.agentMemory = {
    ...memory,
    durableFacts: {
      ...memory.durableFacts,
      latestObservation: semantic,
      currentPage:
        asRecord(semantic.currentPage) ??
        asRecord(memory.durableFacts.currentPage) ??
        null,
      latestReadiness:
        asRecord(semantic.readinessValidation) ??
        asRecord(memory.durableFacts.latestReadiness) ??
        null,
      acceptedEvidenceLedger:
        asRecord(semantic.acceptedEvidenceLedger) ??
        asRecord(memory.durableFacts.acceptedEvidenceLedger) ??
        null,
      currentBrowserState,
      evidenceRefs: mergeUniqueStrings(
        readStringArrayLike(memory.durableFacts.evidenceRefs),
        readStringArrayLike(semantic.evidenceRefs),
      ).slice(-80),
    },
    failedActions: failedActions.slice(-FAILED_ACTION_MEMORY_LIMIT),
    currentBrowserState,
  };
}

export function compactAgentLoopState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const observations = Array.isArray(state.observations)
    ? state.observations.flatMap((entry) =>
        asRecord(entry) ? [entry as Record<string, unknown>] : [],
      )
    : [];
  const retainedObservations = observations
    .slice(-RAW_OBSERVATION_HISTORY_LIMIT)
    .map((entry) => summarizeAgentObservation(entry));
  const compactionEvent = {
    at: new Date().toISOString(),
    originalObservationCount: observations.length,
    retainedObservationCount: retainedObservations.length,
    droppedObservationCount: Math.max(
      0,
      observations.length - retainedObservations.length,
    ),
    semanticObservationCount: readRecordArray(state.semanticObservationHistory)
      .length,
    policy: {
      rawObservationHistoryLimit: RAW_OBSERVATION_HISTORY_LIMIT,
      largeObservationCharLimit: LARGE_OBSERVATION_CHAR_LIMIT,
      semanticObservationHistoryLimit: SEMANTIC_OBSERVATION_HISTORY_LIMIT,
    },
  };
  const memory = ensureAgentMemory(state);
  const compactedMemory = {
    ...memory,
    compactionEvents: [
      ...readRecordArray(memory.compactionEvents),
      compactionEvent,
    ].slice(-COMPACTION_EVENT_LIMIT),
  };
  return {
    ...state,
    observations: retainedObservations,
    semanticObservationHistory: readRecordArray(
      state.semanticObservationHistory,
    ).slice(-SEMANTIC_OBSERVATION_HISTORY_LIMIT),
    agentMemory: compactedMemory,
    compactionSummary: {
      ...compactionEvent,
    },
  };
}

export function buildAgentPromptMetrics(input: {
  readonly instructions: string;
  readonly input: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly attachments?: readonly GantryAgentTaskAttachment[];
}): Record<string, unknown> {
  const state = asRecord(input.input.state);
  const compaction = asRecord(state?.compactionSummary);
  const observations = Array.isArray(state?.observations)
    ? state.observations
    : [];
  const tools = Array.isArray(input.input.availableTools)
    ? input.input.availableTools
    : [];
  const inputJson = JSON.stringify(input.input);
  const outputSchemaJson = JSON.stringify(input.outputSchema);
  const attachments = input.attachments ?? [];
  return {
    instructionsChars: input.instructions.length,
    inputJsonChars: inputJson.length,
    outputSchemaChars: outputSchemaJson.length,
    attachmentCount: attachments.length,
    attachmentLabels: attachments
      .map((attachment) => attachment.label ?? null)
      .filter(Boolean),
    attachmentMimeTypes: [
      ...new Set(attachments.map((attachment) => attachment.mimeType)),
    ],
    observationCount: observations.length,
    availableToolCount: tools.length,
    originalObservationCount:
      typeof compaction?.originalObservationCount === 'number'
        ? compaction.originalObservationCount
        : observations.length,
    retainedObservationCount:
      typeof compaction?.retainedObservationCount === 'number'
        ? compaction.retainedObservationCount
        : observations.length,
    droppedObservationCount:
      typeof compaction?.droppedObservationCount === 'number'
        ? compaction.droppedObservationCount
        : 0,
    semanticObservationCount:
      typeof compaction?.semanticObservationCount === 'number'
        ? compaction.semanticObservationCount
        : Array.isArray(state?.semanticObservationHistory)
          ? state.semanticObservationHistory.length
          : 0,
    agentMemoryChars: JSON.stringify(state?.agentMemory ?? {}).length,
  };
}

export function readValidationReport(
  output: Record<string, unknown>,
  status: GantryAgentTaskResult['status'],
  steps: readonly GantryAgentTaskStep[],
): Record<string, unknown> {
  return (
    asRecord(output.validationReportJson) ??
    asRecord(output.validationReport) ?? { status, agentTaskTrace: { steps } }
  );
}

export function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ensureAgentMemory(state: Record<string, unknown>): GantryAgentMemory {
  const existing = asRecord(state.agentMemory);
  if (existing) {
    return {
      mainGoal: readString(existing, 'mainGoal') ?? 'complete agent task',
      currentGoal:
        readString(existing, 'currentGoal') ??
        readString(asRecord(existing.nextGoal), 'goal') ??
        'continue from durable memory',
      previousGoalEvaluation: normalizePreviousGoalEvaluation(
        asRecord(existing.previousGoalEvaluation),
        null,
      ),
      durableFacts: asRecord(existing.durableFacts) ?? {},
      failedActions: readFailedActions(existing.failedActions),
      nextGoal: normalizeNextGoal(
        asRecord(existing.nextGoal),
        'continue from durable memory',
      ),
      currentBrowserState: normalizeCurrentBrowserState(
        asRecord(existing.currentBrowserState) ??
          asRecord(asRecord(existing.durableFacts)?.currentBrowserState),
      ),
      compactionEvents: readRecordArray(existing.compactionEvents).slice(
        -COMPACTION_EVENT_LIMIT,
      ),
    };
  }
  return {
    mainGoal: 'complete agent task',
    currentGoal: 'start the task with evidence',
    previousGoalEvaluation: {
      goal: null,
      status: 'not_evaluated',
      evidenceRefs: [],
      reason: 'No previous goal has been evaluated yet.',
    },
    durableFacts: {},
    failedActions: [],
    nextGoal: {
      goal: 'start the task with evidence',
      requiredEvidence: [],
      recommendedTool: null,
    },
    currentBrowserState: null,
    compactionEvents: [],
  };
}

function normalizePreviousGoalEvaluation(
  value: Record<string, unknown> | null,
  fallbackGoal: string | null,
): GantryAgentMemory['previousGoalEvaluation'] {
  const rawStatus = readString(value, 'status');
  const status = (
    rawStatus === 'passed' ||
    rawStatus === 'failed' ||
    rawStatus === 'partial' ||
    rawStatus === 'not_evaluated'
      ? rawStatus
      : 'not_evaluated'
  ) as GantryAgentMemory['previousGoalEvaluation']['status'];
  return {
    goal: readString(value, 'goal') ?? fallbackGoal,
    status,
    evidenceRefs: readStringArrayLike(value?.evidenceRefs).slice(0, 20),
    reason:
      readString(value, 'reason') ??
      (status === 'not_evaluated'
        ? 'Previous goal was not evaluated.'
        : 'Previous goal evaluation omitted a reason.'),
  };
}

function normalizeNextGoal(
  value: Record<string, unknown> | null,
  fallbackGoal: string,
): GantryAgentMemory['nextGoal'] {
  return {
    goal: readString(value, 'goal') ?? fallbackGoal,
    requiredEvidence: readStringArrayLike(value?.requiredEvidence).slice(0, 20),
    recommendedTool: readString(value, 'recommendedTool'),
  };
}

function normalizeFailedAction(
  value: Record<string, unknown>,
  fallbackStep: number,
): GantryAgentMemory['failedActions'][number] {
  const rawPolicy = readString(value, 'retryPolicy');
  const retryPolicy = (
    rawPolicy === 'do_not_repeat' ||
    rawPolicy === 'retry_after_new_evidence' ||
    rawPolicy === 'safe_to_retry'
      ? rawPolicy
      : 'retry_after_new_evidence'
  ) as GantryAgentMemory['failedActions'][number]['retryPolicy'];
  const rawStep = value.step;
  return {
    step:
      typeof rawStep === 'number' && Number.isFinite(rawStep)
        ? Math.floor(rawStep)
        : fallbackStep,
    toolName: readString(value, 'toolName'),
    fingerprint: readString(value, 'fingerprint'),
    reason: readString(value, 'reason') ?? 'agent action failed',
    retryPolicy,
  };
}

function readFailedActions(value: unknown): GantryAgentMemory['failedActions'] {
  return readRecordArray(value)
    .map((entry) => normalizeFailedAction(entry, 0))
    .slice(-FAILED_ACTION_MEMORY_LIMIT);
}

function extractAgentSemanticObservation(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const rootObservation = asRecord(value.observation) ?? value;
  const snapshot =
    asRecord(rootObservation.snapshot) ??
    asRecord(rootObservation.browserSnapshot) ??
    asRecord(rootObservation.currentSnapshot);
  const pageClassification =
    asRecord(rootObservation.pageClassification) ??
    asRecord(rootObservation.currentPage) ??
    asRecord(rootObservation.page);
  const pageTransition =
    asRecord(rootObservation.pageTransition) ??
    asRecord(rootObservation.page_transition) ??
    asRecord(rootObservation.progress);
  const selectedAction =
    asRecord(pageTransition?.selectedAction) ??
    asRecord(rootObservation.selectedAction) ??
    asRecord(asRecord(value.input)?.target) ??
    asRecord(value.input);
  const currentBrowserState = normalizeCurrentBrowserState(
    asRecord(rootObservation.currentBrowserState) ??
      buildCurrentBrowserStateFromObservation({
        step: typeof value.step === 'number' ? value.step : null,
        toolName: readString(value, 'toolName'),
        observation: rootObservation,
        selectedAction,
      }),
  );
  const currentPage = compactSemanticRecord({
    url:
      readString(rootObservation, 'url') ??
      readString(snapshot, 'url') ??
      readString(pageClassification, 'url'),
    title:
      readString(rootObservation, 'title') ??
      readString(snapshot, 'title') ??
      readString(pageClassification, 'title'),
    surfaceType:
      readString(rootObservation, 'surfaceType') ??
      readString(pageClassification, 'surfaceType'),
    snapshotId:
      readString(rootObservation, 'snapshotId') ??
      readString(snapshot, 'snapshotId') ??
      readString(pageClassification, 'snapshotId'),
  });
  const evidenceRefs = mergeUniqueStrings(
    collectInterestingStringValues(
      value,
      /(?:screenshot|artifact|snapshot)ref$/i,
    ),
    collectInterestingStringValues(value, /^snapshotId$/i),
  );
  return compactSemanticRecord({
    step: value.step,
    toolName: readString(value, 'toolName'),
    status:
      readString(value, 'status') ??
      readString(rootObservation, 'status') ??
      null,
    error:
      readString(value, 'error') ??
      readString(rootObservation, 'error') ??
      null,
    reason:
      readString(rootObservation, 'reason') ??
      readString(rootObservation, 'instruction') ??
      null,
    currentPage,
    evidenceRefs,
    selectedAction: compactSelectedAction(selectedAction),
    pageTransition: compactSemanticRecord({
      outcome:
        readString(pageTransition, 'outcome') ??
        readString(pageTransition, 'status'),
      reason: readString(pageTransition, 'reason'),
      selectedAction: compactSelectedAction(selectedAction),
    }),
    readinessValidation: compactSemanticValue(
      asRecord(rootObservation.readinessValidation) ??
        asRecord(rootObservation.readiness),
    ),
    finalValidation: compactSemanticValue(
      asRecord(rootObservation.finalValidation),
    ),
    recoveryDirective: compactSemanticValue(
      asRecord(rootObservation.recoveryDirective),
    ),
    currentBrowserState: compactSemanticValue(currentBrowserState),
    openSurfaces: compactSemanticValue(currentBrowserState?.openSurfaces),
    blockingOverlay: compactSemanticValue(currentBrowserState?.blockingOverlay),
    actionCandidates: compactSemanticValue(
      currentBrowserState?.actionCandidates,
    ),
    acceptedEvidenceLedger: compactSemanticValue(
      asRecord(rootObservation.acceptedEvidenceLedger) ??
        asRecord(
          asRecord(rootObservation.builderState)?.acceptedEvidenceLedger,
        ),
    ),
  });
}

function normalizeCurrentBrowserState(
  value: Record<string, unknown> | null,
): GantryAgentCurrentBrowserState | null {
  if (!value) return null;
  const rawFreshness = readString(value, 'visualFreshness');
  const visualFreshness = (
    rawFreshness === 'current' ||
    rawFreshness === 'previous' ||
    rawFreshness === 'missing' ||
    rawFreshness === 'mismatch'
      ? rawFreshness
      : 'missing'
  ) as GantryAgentCurrentBrowserState['visualFreshness'];
  return compactSemanticRecord({
    step:
      typeof value.step === 'number' && Number.isFinite(value.step)
        ? Math.floor(value.step)
        : null,
    toolName: readString(value, 'toolName'),
    url: readString(value, 'url'),
    title: readString(value, 'title'),
    snapshotId: readString(value, 'snapshotId'),
    screenshotRef: readString(value, 'screenshotRef'),
    visualFreshness,
    openSurfaces: readRecordArray(value.openSurfaces).slice(0, 8),
    activeSurface: asRecord(value.activeSurface),
    blockingOverlay: asRecord(value.blockingOverlay),
    selectedAction: asRecord(value.selectedAction),
    lastActionResult: asRecord(value.lastActionResult),
    actionCandidates: readRecordArray(value.actionCandidates).slice(0, 24),
  }) as unknown as GantryAgentCurrentBrowserState;
}

function buildCurrentBrowserStateFromObservation(input: {
  readonly step: number | null;
  readonly toolName?: string | null;
  readonly observation: Record<string, unknown>;
  readonly selectedAction?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const snapshot =
    asRecord(input.observation.snapshot) ??
    asRecord(input.observation.browserSnapshot) ??
    asRecord(input.observation.currentSnapshot);
  const selectorEvidence = asRecord(input.observation.selectorEvidence);
  const screenshot = asRecord(input.observation.screenshot);
  const screenshotRef =
    readString(input.observation, 'screenshotRef') ??
    readString(screenshot, 'screenshotRef') ??
    readString(screenshot, 'ref') ??
    readString(screenshot, 'localPath');
  const hasBrowserState =
    Boolean(snapshot) ||
    Boolean(selectorEvidence) ||
    Boolean(readString(input.observation, 'currentUrl')) ||
    Boolean(readString(input.observation, 'url'));
  if (
    !hasBrowserState &&
    !screenshotRef &&
    !readString(input.observation, 'error')
  )
    return null;
  const openSurfaces = collectOpenSurfaces(input.observation);
  const blockingOverlay =
    openSurfaces[0] ?? buildPointerInterceptOverlay(input.observation);
  const pageTransition = asRecord(input.observation.pageTransition);
  const actionCandidates = collectBrowserActionCandidates(input.observation);
  return compactSemanticRecord({
    step: input.step,
    toolName: input.toolName,
    url:
      readString(input.observation, 'currentUrl') ??
      readString(input.observation, 'url') ??
      readString(snapshot, 'url'),
    title:
      readString(input.observation, 'title') ?? readString(snapshot, 'title'),
    snapshotId:
      readString(input.observation, 'snapshotId') ??
      readString(snapshot, 'snapshotId'),
    screenshotRef,
    visualFreshness: screenshotRef
      ? 'current'
      : hasBrowserState
        ? 'missing'
        : 'previous',
    openSurfaces,
    activeSurface: openSurfaces[0] ?? null,
    blockingOverlay,
    selectedAction:
      asRecord(pageTransition?.selectedAction) ?? input.selectedAction ?? null,
    lastActionResult: compactSemanticRecord({
      status: readString(input.observation, 'status'),
      error: readString(input.observation, 'error'),
      mode: readString(input.observation, 'mode'),
      pageTransition: pageTransition
        ? compactSemanticRecord({
            outcome:
              readString(pageTransition, 'outcome') ??
              readString(pageTransition, 'status'),
            reason: readString(pageTransition, 'reason'),
          })
        : null,
    }),
    actionCandidates,
  });
}

function collectBrowserActionCandidates(
  observation: Record<string, unknown>,
): Record<string, unknown>[] {
  const snapshot =
    asRecord(observation.snapshot) ??
    asRecord(observation.browserSnapshot) ??
    asRecord(observation.currentSnapshot);
  const candidates: Record<string, unknown>[] = [];
  const push = (candidate: Record<string, unknown>): void => {
    const compacted = compactSemanticRecord(candidate);
    const key = JSON.stringify([
      compacted.type,
      compacted.selector,
      compacted.ref,
      compacted.text,
      compacted.onclick,
      compacted.ngClick,
      compacted.tableIndex,
      compacted.rowIndex,
    ]);
    if (
      candidates.some(
        (entry) =>
          JSON.stringify([
            entry.type,
            entry.selector,
            entry.ref,
            entry.text,
            entry.onclick,
            entry.ngClick,
            entry.tableIndex,
            entry.rowIndex,
          ]) === key,
      )
    )
      return;
    candidates.push(compacted);
  };

  for (const table of readRecordArray(snapshot?.tables).slice(0, 6)) {
    const tableIndex = readNumberLike(table.tableIndex);
    const headers = readStringArrayLike(table.headers).slice(0, 8);
    const rows = readRecordArray(table.rows).slice(0, 4);
    const rowSelector =
      typeof tableIndex === 'number'
        ? `table:nth-of-type(${tableIndex + 1}) tbody tr`
        : null;
    if (rows.length > 0) {
      push({
        type: 'table_rows',
        selector: rowSelector,
        tableIndex,
        rowCount: rows.length,
        headers,
        samples: rows.map((row) =>
          readStringArrayLike(row.cells).join(' | ').slice(0, 320),
        ),
      });
    }
    for (const row of rows) {
      const rowIndex = readNumberLike(row.rowIndex);
      const rowText = readStringArrayLike(row.cells).join(' | ').slice(0, 320);
      for (const action of readRecordArray(row.actionRefs).slice(0, 8)) {
        const actionText = candidateText(action);
        const signal = `${actionText} ${readString(action, 'selector') ?? ''} ${readString(action, 'onclick') ?? ''} ${readString(action, 'ngClick') ?? ''} ${readString(action, 'className') ?? ''}`;
        if (
          /\b(view|detail|preview|open|tender|download|document|nit|boq|corrigendum|more)\b/i.test(
            signal,
          )
        ) {
          push({
            type: /download|document|nit|boq|corrigendum/i.test(signal)
              ? 'document_action'
              : 'row_detail_action',
            tableIndex,
            rowIndex,
            rowText,
            ref: readString(action, 'ref'),
            snapshotId:
              readString(action, 'snapshotId') ??
              readString(snapshot, 'snapshotId'),
            selector: readString(action, 'selector'),
            text: actionText,
            onclick: readString(action, 'onclick'),
            ngClick: readString(action, 'ngClick'),
            className: readString(action, 'className'),
          });
        }
      }
    }
  }

  for (const control of readRecordArray(snapshot?.interactive).slice(0, 80)) {
    const text = candidateText(control);
    const signal = [
      text,
      readString(control, 'ariaLabel'),
      readString(control, 'name'),
      readString(control, 'id'),
      readString(control, 'className'),
      readString(control, 'href'),
      readString(control, 'onclick'),
      readString(control, 'ngClick'),
      readString(control, 'value'),
      readString(control, 'title'),
      readString(control, 'selector'),
    ]
      .filter(Boolean)
      .join(' ');
    const base = {
      ref: readString(control, 'ref'),
      snapshotId:
        readString(control, 'snapshotId') ?? readString(snapshot, 'snapshotId'),
      selector: readString(control, 'selector'),
      text,
      label: readString(control, 'ariaLabel') ?? readString(control, 'title'),
      href: readString(control, 'href'),
      onclick: readString(control, 'onclick'),
      ngClick: readString(control, 'ngClick'),
      className: readString(control, 'className'),
    };
    if (isPaginationSignal(signal))
      push({ type: 'pagination_action', ...base });
    else if (
      /\b(search|submit|apply|go|show|list|captcha|security code|verification code)\b/i.test(
        signal,
      )
    ) {
      push({ type: 'form_action', ...base });
    } else if (isDocumentSignal(signal))
      push({ type: 'document_action', ...base });
    else if (/\b(view|detail|preview|open|tender)\b/i.test(signal)) {
      push({ type: 'detail_action', ...base });
    }
  }

  for (const control of readRecordArray(snapshot?.documentControls).slice(
    0,
    12,
  )) {
    push({
      type: 'document_action',
      ref: readString(control, 'ref'),
      snapshotId:
        readString(control, 'snapshotId') ?? readString(snapshot, 'snapshotId'),
      selector: readString(control, 'selector'),
      text: candidateText(control),
      href: readString(control, 'href'),
      onclick: readString(control, 'onclick'),
      ngClick: readString(control, 'ngClick'),
      className: readString(control, 'className'),
    });
  }

  for (const form of readRecordArray(snapshot?.forms).slice(0, 6)) {
    push({
      type: 'form',
      formIndex: readNumberLike(form.formIndex),
      action: readString(form, 'action'),
      method: readString(form, 'method'),
      fields: readRecordArray(form.fields)
        .slice(0, 12)
        .map((field) =>
          compactSemanticRecord({
            tag: readString(field, 'tag'),
            name: readString(field, 'name'),
            id: readString(field, 'id'),
            type: readString(field, 'type'),
            placeholder: readString(field, 'placeholder'),
            label: readString(field, 'label'),
          }),
        ),
    });
  }

  for (const modal of readRecordArray(snapshot?.modals).slice(0, 4)) {
    for (const action of readRecordArray(modal.actions).slice(0, 8)) {
      push({
        type: 'modal_action',
        modalSelector: readString(modal, 'selector'),
        modalText: readString(modal, 'text')?.slice(0, 320),
        ref: readString(action, 'ref'),
        snapshotId:
          readString(action, 'snapshotId') ??
          readString(snapshot, 'snapshotId'),
        selector: readString(action, 'selector'),
        text: candidateText(action),
        onclick: readString(action, 'onclick'),
        ngClick: readString(action, 'ngClick'),
        className: readString(action, 'className'),
      });
    }
  }

  return candidates
    .sort(
      (left, right) => scoreActionCandidate(right) - scoreActionCandidate(left),
    )
    .slice(0, 24);
}

function candidateText(value: Record<string, unknown>): string | null {
  return (
    readString(value, 'text') ??
    readString(value, 'label') ??
    readString(value, 'ariaLabel') ??
    readString(value, 'title') ??
    readString(value, 'value')
  );
}

function isPaginationSignal(value: string): boolean {
  return /\b(next|previous|prev|pagination|page|more|load more|show more|view more|more tenders|load more tenders|clickForMoreTender|nextPage|gotoPage|loadMore|fetchMore)\b|^>$|^>>$|(?:^|\s)[1-9](?:\s|$)|\.\.\./i.test(
    value,
  );
}

function isDocumentSignal(value: string): boolean {
  return (
    /\b(document|download|pdf|nit|boq|corrigendum|attachment|file|downloadFile|fa-download)\b/i.test(
      value,
    ) &&
    !/\b(manual|faq|help|pki|dsc|signature|vendor registration|how to start|system requirement)\b/i.test(
      value,
    )
  );
}

function scoreActionCandidate(value: Record<string, unknown>): number {
  const type = readString(value, 'type') ?? '';
  const signal = Object.values(value)
    .filter((entry) => typeof entry === 'string')
    .join(' ');
  let score = 0;
  if (type.includes('document')) score += 80;
  if (type.includes('pagination')) score += 70;
  if (type.includes('row_detail') || type.includes('detail')) score += 60;
  if (type.includes('form')) score += 45;
  if (type === 'table_rows') score += 40;
  if (readString(value, 'ref')) score += 8;
  if (readString(value, 'selector')) score += 6;
  if (/captcha|search|submit|apply/i.test(signal)) score += 12;
  if (/download|document|nit|boq|corrigendum/i.test(signal)) score += 16;
  if (/next|more|page|clickForMoreTender|gotoPage/i.test(signal)) score += 16;
  return score;
}

function readNumberLike(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function collectOpenSurfaces(value: unknown): Record<string, unknown>[] {
  const surfaces: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (entry: unknown, depth: number): void => {
    if (entry === null || entry === undefined || depth > 7 || seen.has(entry))
      return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    const record = asRecord(entry);
    if (!record) return;
    seen.add(record);
    const role = readString(record, 'role');
    const selector = readString(record, 'selector');
    const id = readString(record, 'id');
    const className =
      readString(record, 'className') ?? readString(record, 'class');
    const open =
      record.open === true || readString(record, 'ariaHidden') === 'false';
    const modalLike = /modal|dialog|overlay|backdrop/i.test(
      [role, selector, id, className].filter(Boolean).join(' '),
    );
    if (open && modalLike) {
      surfaces.push(
        compactSemanticRecord({
          type: /dialog/i.test(role ?? '') ? 'dialog' : 'modal',
          selector,
          id,
          role,
          text: readString(record, 'text'),
          actionCount: Array.isArray(record.actions)
            ? record.actions.length
            : null,
          documentControlCount: Array.isArray(record.documentControls)
            ? record.documentControls.length
            : null,
        }),
      );
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  return surfaces.slice(0, 8);
}

function buildPointerInterceptOverlay(
  observation: Record<string, unknown>,
): Record<string, unknown> | null {
  const error = readString(observation, 'error');
  if (!error || !/intercepts pointer events/i.test(error)) return null;
  const idMatch = /id="([^"]+)"/i.exec(error);
  const classMatch = /class="([^"]+)"/i.exec(error);
  return compactSemanticRecord({
    type: 'blocking_overlay',
    selector: idMatch?.[1]
      ? `#${idMatch[1]}`
      : classMatch?.[1]
        ? `.${classMatch[1].split(/\s+/)[0]}`
        : null,
    text: error.slice(0, 800),
    reason: 'pointer_events_intercepted',
  });
}

function compactSelectedAction(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) return null;
  return compactSemanticRecord({
    ref: readString(value, 'ref'),
    snapshotId: readString(value, 'snapshotId'),
    selector: readString(value, 'selector'),
    text: readString(value, 'text'),
    label: readString(value, 'label'),
    url: readString(value, 'url'),
    action: readString(value, 'action'),
    fingerprint: readString(value, 'fingerprint'),
  });
}

function compactSemanticRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, compactSemanticValue(entry)] as const)
      .filter(([, entry]) => entry !== null && entry !== undefined),
  );
}

function compactSemanticValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > SEMANTIC_TEXT_LIMIT
      ? `${value.slice(0, SEMANTIC_TEXT_LIMIT)}...`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => compactSemanticValue(entry));
  }
  const record = asRecord(value);
  if (!record) return value;
  const entries = Object.entries(record).slice(0, 40);
  return Object.fromEntries(
    entries
      .map(([key, entry]) => [key, compactSemanticValue(entry)] as const)
      .filter(([, entry]) => entry !== null && entry !== undefined),
  );
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
    : [];
}

function readStringArrayLike(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === 'string' && entry.trim() ? [entry.trim()] : [],
      )
    : [];
}

function mergeUniqueStrings(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat().filter(Boolean))];
}

function collectInterestingStringValues(
  value: unknown,
  keyPattern: RegExp,
  depth = 0,
): string[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      collectInterestingStringValues(entry, keyPattern, depth + 1),
    );
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, entry]) => {
    const direct =
      keyPattern.test(key) && typeof entry === 'string' && entry.trim()
        ? [entry.trim()]
        : [];
    return [
      ...direct,
      ...collectInterestingStringValues(entry, keyPattern, depth + 1),
    ];
  });
}

function readNoProgressReasonFromObservation(
  observation: Record<string, unknown>,
): string | null {
  const direct =
    readString(observation, 'noProgressReason') ??
    readString(observation, 'no_progress_reason');
  if (observation.noProgress === true) return direct ?? 'tool_no_progress';
  const transition =
    asRecord(observation.pageTransition) ??
    asRecord(observation.page_transition) ??
    asRecord(observation.progress);
  const outcome =
    readString(transition, 'outcome') ?? readString(transition, 'status');
  if (outcome === 'no_progress') {
    return readString(transition, 'reason') ?? direct ?? 'tool_no_progress';
  }
  return null;
}
