import type {
  GantryAgentTaskAttachment,
  GantryAgentTaskAttachmentRequest,
  GantryAgentTaskInput,
  GantryAgentTaskResult,
  GantryAgentTaskStep,
} from '../shared/types.js';
import { asRecord, readString } from '../shared/helpers.js';

export function normalizeAgentMaxSteps(
  value: number | null | undefined,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1)
    return 12;
  return Math.min(50, Math.floor(value));
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
    'Include concise auditNote, whyThisStep, expectedOutcome, and nextIfFails fields so operators can audit what you are doing without hidden reasoning.',
    'When screenshots or image attachments are available, also include visualSummary, visibleTarget, whyThisAction, expectedStateChange, and fallbackIfWrong.',
    'YOU MUST USE THE SCREENSHOT IMAGE AND CURRENT BROWSER STATE AS THE PRIMARY TRUTH BEFORE EVERY BROWSER ACTION AND BEFORE CLAIMING SUCCESS.',
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

export function buildGenericAgentActionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['call_tool', 'final', 'needs_input'] },
      toolName: { type: 'string' },
      input: { type: 'object' },
      output: { type: 'object' },
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
  };
}

export function summarizeAgentObservation(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (json.length <= 8_000) return value;
  return {
    truncated: true,
    originalCharCount: json.length,
    excerpt: json.slice(0, 8_000),
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
    .slice(-6)
    .map((entry) => summarizeAgentObservation(entry));
  return {
    ...state,
    observations: retainedObservations,
    compactionSummary: {
      originalObservationCount: observations.length,
      retainedObservationCount: retainedObservations.length,
      droppedObservationCount: Math.max(
        0,
        observations.length - retainedObservations.length,
      ),
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
