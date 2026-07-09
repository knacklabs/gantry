import { createHash } from 'node:crypto';
import {
  propagateAttributes,
  startActiveObservation,
  type LangfuseObservation,
  type LangfuseObservationType,
} from '@langfuse/tracing';

export interface GantryModelObservationInput<TOutput> {
  readonly operationName: string;
  readonly taskType?: string | null;
  readonly modelCallType: 'generation' | 'agent_step';
  readonly provider: string;
  readonly model: string;
  readonly attempt?: number;
  readonly input?: unknown;
  readonly output?: unknown | ((result: TOutput) => unknown);
  readonly usageDetails?: Record<string, number> | ((result: TOutput) => Record<string, number> | undefined);
  readonly modelParameters?: Record<string, string | number>;
  readonly metadata?: Record<string, unknown>;
  readonly resultMetadata?: (result: TOutput) => Record<string, unknown>;
}

export interface GantryAgentSpanInput<TOutput> {
  readonly operationName: 'runStructuredTask' | 'runAgentTask';
  readonly taskType: string;
  readonly correlationId?: string | null;
  readonly input?: unknown;
  readonly output?: unknown | ((result: TOutput) => unknown);
  readonly metadata?: Record<string, unknown>;
}

export async function observeGantryModelCall<TOutput>(
  input: GantryModelObservationInput<TOutput>,
  operation: () => Promise<TOutput>,
): Promise<TOutput> {
  return observeGantryOperation({
    asType: 'generation',
    operationName: input.operationName,
    costStage: 'agent.structured_model',
    taskType: input.taskType,
    modelCallType: input.modelCallType,
    provider: input.provider,
    model: input.model,
    attempt: input.attempt,
    input: input.input,
    output: input.output,
    usageDetails: input.usageDetails,
    modelParameters: input.modelParameters,
    metadata: input.metadata,
    resultMetadata: input.resultMetadata,
  }, operation);
}

export async function observeGantryAgentSpan<TOutput>(
  input: GantryAgentSpanInput<TOutput>,
  operation: () => Promise<TOutput>,
): Promise<TOutput> {
  const costStage = input.operationName === 'runStructuredTask'
    ? 'agent.structured_task'
    : 'agent.agent_task';
  return observeGantryOperation({
    asType: 'agent',
    operationName: input.operationName,
    costStage,
    taskType: input.taskType,
    modelCallType: 'agent_step',
    provider: 'gantry',
    model: 'agent-orchestrator',
    input: input.input,
    output: input.output,
    metadata: {
      correlation_id: input.correlationId ?? null,
      ...(input.metadata ?? {}),
    },
  }, operation);
}

export function extractAnthropicUsageDetails(response: unknown): Record<string, number> | undefined {
  const usage = readRecord(readRecord(response)?.usage);
  if (!usage) return undefined;
  const inputTokens = readNumber(usage.input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  return compactUsage({
    input: inputTokens,
    output: outputTokens,
    total: sumDefined(inputTokens, outputTokens),
    cache_creation_input: readNumber(usage.cache_creation_input_tokens),
    cached_input: readNumber(usage.cache_read_input_tokens),
  });
}

async function observeGantryOperation<TOutput>(
  input: {
    readonly asType: LangfuseObservationType;
    readonly operationName: string;
    readonly costStage: string;
    readonly taskType?: string | null;
    readonly modelCallType: 'generation' | 'agent_step';
    readonly provider: string;
    readonly model: string;
    readonly attempt?: number;
    readonly input?: unknown;
    readonly output?: unknown | ((result: TOutput) => unknown);
    readonly usageDetails?: Record<string, number> | ((result: TOutput) => Record<string, number> | undefined);
    readonly modelParameters?: Record<string, string | number>;
    readonly metadata?: Record<string, unknown>;
    readonly resultMetadata?: (result: TOutput) => Record<string, unknown>;
  },
  operation: () => Promise<TOutput>,
): Promise<TOutput> {
  if (!isLangfuseEnabled()) {
    return operation();
  }
  const metadata = buildMetadata(input, 'pending');
  try {
    return await propagateAttributes(
      {
        traceName: input.costStage,
        tags: [
          'category:agent',
          `stage:${input.costStage}`,
          `kind:${input.modelCallType}`,
          `provider:${input.provider}`,
          'service:agent-gantry',
        ],
        metadata: stringifyTraceMetadata(metadata),
      },
      async () => startTypedObservation(
        input.costStage,
        async (observation) => {
          updateObservation(observation, {
            input: summarizePayload(input.input),
            metadata,
            model: input.model,
            modelParameters: input.modelParameters,
            environment: process.env.NODE_ENV ?? 'development',
          });
          try {
            const result = await operation();
            updateObservation(observation, {
              output: summarizePayload(resolveMaybeFunction(input.output, result)),
              metadata: buildMetadata(input, 'success', result),
              usageDetails: resolveMaybeFunction(input.usageDetails, result),
            });
            return result;
          } catch (error) {
            updateObservation(observation, {
              metadata: {
                ...buildMetadata(input, 'error'),
                error_message: error instanceof Error ? error.message : String(error),
                error_name: error instanceof Error ? error.name : 'Error',
              },
              level: 'ERROR',
              statusMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
        input.asType,
      ),
    );
  } catch (error) {
    if (error instanceof Error && /langfuse|otel|opentelemetry/i.test(`${error.name} ${error.message}`)) {
      return operation();
    }
    throw error;
  }
}

function buildMetadata<TOutput>(
  input: {
    readonly operationName: string;
    readonly costStage: string;
    readonly taskType?: string | null;
    readonly modelCallType: 'generation' | 'agent_step';
    readonly provider: string;
    readonly model: string;
    readonly attempt?: number;
    readonly metadata?: Record<string, unknown>;
    readonly resultMetadata?: (result: TOutput) => Record<string, unknown>;
  },
  status: 'pending' | 'success' | 'error',
  result?: TOutput,
): Record<string, unknown> {
  return {
    cost_category: 'agent',
    cost_stage: input.costStage,
    operation_name: input.operationName,
    ...(input.taskType ? { task_type: input.taskType } : {}),
    model_call_type: input.modelCallType,
    provider: input.provider,
    model: input.model,
    service_name: 'agent-gantry',
    environment: process.env.NODE_ENV ?? 'development',
    status,
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.metadata ?? {}),
    ...(result === undefined || !input.resultMetadata ? {} : input.resultMetadata(result)),
  };
}

function startTypedObservation<TOutput>(
  name: string,
  fn: (observation: LangfuseObservation) => Promise<TOutput>,
  asType: LangfuseObservationType,
): Promise<TOutput> {
  const start = startActiveObservation as unknown as (
    observationName: string,
    observationFn: (observation: LangfuseObservation) => Promise<TOutput>,
    options: { readonly asType: LangfuseObservationType },
  ) => Promise<TOutput>;
  return start(name, fn, { asType });
}

function updateObservation(observation: LangfuseObservation, attributes: Record<string, unknown>): void {
  ((observation as { update(nextAttributes: Record<string, unknown>): unknown }).update)(attributes);
}

function summarizePayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  const policy = process.env.LANGFUSE_CAPTURE_PAYLOADS?.trim().toLowerCase() || 'preview';
  if (policy === 'full') return value;
  if (policy === 'off' || policy === 'none') return undefined;
  const serialized = stringifyPayload(value);
  const digest = createHash('sha256').update(serialized).digest('hex');
  if (policy === 'hash' || policy === 'metadata') {
    return { sha256: digest, chars: serialized.length };
  }
  return { preview: serialized.slice(0, 1000), sha256: digest, chars: serialized.length };
}

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return `[binary:${value.byteLength}]`;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function resolveMaybeFunction<TOutput, TValue>(
  value: TValue | ((result: TOutput) => TValue) | undefined,
  result: TOutput,
): TValue | undefined {
  return typeof value === 'function'
    ? (value as (resolvedResult: TOutput) => TValue)(result)
    : value;
}

function stringifyTraceMetadata(metadata: Record<string, unknown>): Record<string, string> {
  const propagated: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' && value.length <= 200) propagated[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') propagated[key] = String(value);
  }
  return propagated;
}

function isLangfuseEnabled(): boolean {
  const explicit = process.env.LANGFUSE_TRACING_ENABLED?.trim().toLowerCase();
  return explicit !== 'false' && explicit !== '0';
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function readNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function sumDefined(...values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : defined.reduce((sum, value) => sum + value, 0);
}

function compactUsage(values: Record<string, number | undefined>): Record<string, number> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
