import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type {
  GantryAgentTaskCancellationRequest,
  GantryAgentTaskInput,
  GantryAgentTaskResult,
  GantryAgentTaskStep,
  GantryAgentTool,
  GantryObservabilityContext,
  GantryStructuredModelUsage,
  StructuredModelTaskRunnerConfig,
  StructuredJsonModelProvider,
} from '../shared/types.js';
import { asRecord, parseCompleteJsonRecord } from '../shared/helpers.js';
import {
  buildAgentStepInstructions,
  buildAgentPromptMetrics,
  createInitialAgentMemory,
  buildGenericAgentActionSchema,
  cloneJsonRecord,
  compactAgentLoopState,
  mergeModelProgressIntoAgentMemory,
  normalizeAgentMaxSteps,
  parseGenericAgentAction,
  recordAgentMemoryObservation,
  readAgentStepAttachments,
  readOptionalString,
  readValidationReport,
  resolveAgentDeadlineMs,
  runWithOptionalTimeout,
  summarizeAgentObservation,
} from './agent-task-runner-helpers.js';
import {
  readStructuredModelStopError,
  unwrapStructuredJsonModelProviderResult,
} from './model-provider.js';
import { observeGantryWorkflowSpan } from './model-observability.js';

export async function runGenericAgentTask(
  config: Omit<StructuredModelTaskRunnerConfig, 'model'> & {
    readonly model: StructuredJsonModelProvider;
  },
  input: GantryAgentTaskInput,
): Promise<GantryAgentTaskResult> {
  const taskRunId = input.correlationId ?? randomUUID();
  const maxSteps = normalizeAgentMaxSteps(input.maxSteps);
  const deadlineMs = resolveAgentDeadlineMs(input.deadlineAt);
  const startedAt = Date.now();
  const steps: GantryAgentTaskStep[] = [];
  const warnings: string[] = [];
  const modelUsages: GantryStructuredModelUsage[] = [];
  const repeatedFailures = new Map<string, number>();
  const actionSchema = buildGenericAgentActionSchema(input.finalSchema);
  let validateAction: ValidateFunction | null = null;
  let schemaCompilationError: string | null = null;
  try {
    validateAction = new Ajv({ allErrors: true, strict: false }).compile(
      actionSchema,
    );
  } catch (error) {
    schemaCompilationError =
      error instanceof Error ? error.message : String(error);
  }
  let consecutiveModelOutputFailures = 0;
  const traceDir = resolveAgentModelTraceDir(input);
  const state: Record<string, unknown> = {
    input: input.input,
    observations: [],
    semanticObservationHistory: [],
    agentMemory: createInitialAgentMemory(input),
  };

  const recordStep = async (stepEntry: GantryAgentTaskStep): Promise<void> => {
    steps.push(stepEntry);
    if (!input.onStep) return;
    try {
      await input.onStep(stepEntry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`agent_step_trace_callback_failed:${message}`);
    }
  };

  const isCancelled = async (
    step: number,
    phase: GantryAgentTaskCancellationRequest['phase'],
    toolName?: string | null,
  ): Promise<boolean> => {
    if (!input.shouldCancel) return false;
    return Boolean(
      await input.shouldCancel({
        taskType: input.taskType,
        correlationId: input.correlationId,
        step,
        state,
        phase,
        toolName: toolName ?? null,
      }),
    );
  };

  const validateFinalOutput = async (inputArgs: {
    readonly step: number;
    readonly output: Record<string, unknown>;
    readonly source: 'model_final' | 'tool_final_output';
    readonly toolName?: string | null;
  }): Promise<{
    readonly accepted: boolean;
    readonly reason?: string | null;
    readonly instruction?: string | null;
    readonly details?: Record<string, unknown> | null;
  }> => {
    if (!validateAction?.({ action: 'final', output: inputArgs.output })) {
      return {
        accepted: false,
        reason:
          inputArgs.source === 'tool_final_output'
            ? 'tool_final_output_schema_invalid'
            : 'model_output_schema_invalid',
        instruction: 'Return a final output that matches the supplied schema.',
        details: { schemaErrors: formatSchemaErrors(validateAction?.errors) },
      };
    }
    if (!input.validateFinal) return { accepted: true };
    try {
      const result = await input.validateFinal({
        taskType: input.taskType,
        correlationId: input.correlationId,
        step: inputArgs.step,
        state,
        output: inputArgs.output,
        source: inputArgs.source,
        toolName: inputArgs.toolName ?? null,
      });
      return result ?? { accepted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        accepted: false,
        reason: 'final_validation_exception',
        instruction:
          'The final output validation hook failed. Continue by gathering explicit evidence and calling readiness validation before finalizing again.',
        details: { error: message },
      };
    }
  };

  const applyFinalValidationRejection = (inputArgs: {
    readonly step: number;
    readonly source: 'model_final' | 'tool_final_output';
    readonly toolName?: string | null;
    readonly validation: {
      readonly accepted: boolean;
      readonly reason?: string | null;
      readonly instruction?: string | null;
      readonly details?: Record<string, unknown> | null;
    };
  }): Record<string, unknown> => {
    const reason = inputArgs.validation.reason ?? 'final_validation_rejected';
    const instruction =
      inputArgs.validation.instruction ??
      'Do not finalize yet. Use the validation details to gather the missing proof, repair the builder state, and validate readiness again.';
    state.recoveryHint = {
      error: 'final_validation_rejected',
      reason,
      instruction,
      source: inputArgs.source,
      toolName: inputArgs.toolName ?? null,
      details: inputArgs.validation.details ?? null,
    };
    const observations = Array.isArray(state.observations)
      ? [...state.observations]
      : [];
    observations.push({
      step: inputArgs.step,
      toolName: inputArgs.toolName ?? inputArgs.source,
      input: null,
      observation: {
        status: 'failed',
        error: 'final_validation_rejected',
        finalValidation: inputArgs.validation,
      },
      auditNote: 'Final output rejected by task-specific validator.',
    });
    state.observations = observations;
    state.lastObservation = {
      status: 'failed',
      error: 'final_validation_rejected',
      finalValidation: inputArgs.validation,
    };
    recordAgentMemoryObservation(state, {
      step: inputArgs.step,
      toolName: inputArgs.toolName ?? inputArgs.source,
      actionInput: null,
      observation: state.lastObservation as Record<string, unknown>,
      status: 'failed',
      error: reason,
    });
    return state.lastObservation as Record<string, unknown>;
  };

  const finish = async (
    status: GantryAgentTaskResult['status'],
    output: Record<string, unknown>,
    validationReport?: Record<string, unknown> | null,
    error?: string | null,
  ): Promise<GantryAgentTaskResult> => {
    const modelUsage = aggregateModelUsage({
      usages: modelUsages,
      taskType: input.taskType,
      correlationId: input.correlationId ?? null,
      durationMs: Date.now() - startedAt,
    });
    const outputWithTrace = {
      ...output,
      agentTaskTrace: { steps, warnings },
    };
    const result: GantryAgentTaskResult = {
      status,
      output: outputWithTrace,
      validationReport:
        validationReport ??
        readValidationReport(outputWithTrace, status, steps),
      steps,
      warnings,
      modelUsage,
    };
    await config.storage?.recordStructuredTaskRun?.({
      taskRunId,
      taskType: input.taskType,
      correlationId: input.correlationId,
      status,
      input: input.input,
      output: result.output,
      validationReport: result.validationReport,
      error: error ?? null,
      occurredAt: new Date().toISOString(),
    });
    return result;
  };

  if (schemaCompilationError || !validateAction) {
    const error = 'invalid_final_schema';
    return await finish(
      'failed',
      { status: 'failed', error, details: schemaCompilationError },
      null,
      error,
    );
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    const remainingMs =
      deadlineMs === null ? null : deadlineMs - (Date.now() - startedAt);
    if (remainingMs !== null && remainingMs <= 0) {
      warnings.push('agent_task_deadline_exceeded');
      return await finish(
        'needs_review',
        {
          status: 'needs_review',
          reason: 'agent_task_deadline_exceeded',
        },
        null,
        'agent_task_deadline_exceeded',
      );
    }

    const stepStartedAt = Date.now();
    const stepStartedIso = new Date().toISOString();
    if (await isCancelled(step, 'before_model')) {
      await recordStep({
        step,
        actionType: 'cancelled',
        status: 'skipped',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        observation: { status: 'cancelled', reason: 'agent_task_cancelled' },
      });
      return await finish(
        'failed',
        { status: 'cancelled', reason: 'agent_task_cancelled' },
        null,
        'agent_task_cancelled',
      );
    }
    let action: Record<string, unknown> | null = null;
    let modelOutputFailure: {
      readonly code: string;
      readonly details?: Record<string, unknown>;
    } | null = null;
    let promptMetrics: Record<string, unknown> | null = null;
    const stepTools = await selectToolsForStep(input, {
      step,
      maxSteps,
      state,
    });
    try {
      const instructions = await buildAgentStepInstructions(input, {
        taskType: input.taskType,
        correlationId: input.correlationId,
        step,
        state,
      });
      let modelInput = await buildAgentModelInput(input, {
        step,
        state,
        stepTools,
        attempt: 'primary',
      });
      const attachments = await readAgentStepAttachments(input, {
        taskType: input.taskType,
        correlationId: input.correlationId,
        step,
        state,
      });
      promptMetrics = buildAgentPromptMetrics({
        instructions,
        input: modelInput,
        outputSchema: actionSchema,
        attachments,
      });
      promptMetrics = attachPromptCacheRequestMetrics(promptMetrics, input);
      const traceAttachments = await persistTraceAttachments(
        traceDir,
        step,
        attachments,
      );
      await writeAgentModelTrace(traceDir, {
        kind: 'model_input',
        taskRunId,
        taskType: input.taskType,
        correlationId: input.correlationId ?? null,
        step,
        createdAt: new Date().toISOString(),
        instructions,
        modelInput,
        outputSchema: actionSchema,
        attachments: traceAttachments,
        promptMetrics,
      });
      let generated: unknown;
      let generatedRawText: string | null = null;
      let generatedStopReason: string | null = null;
      try {
        const generatedResult = unwrapStructuredJsonModelProviderResult(
          await runWithOptionalTimeout(
            observeGantryWorkflowSpan(
              {
                operationName: 'agent_step.model',
                costStage: 'agent.step',
                taskType: input.taskType,
                correlationId: input.correlationId ?? null,
                input: { step, attempt: 'primary', promptMetrics },
                output: (result: unknown) =>
                  summarizeAgentObservation(asRecord(result) ?? {}),
                metadata: {
                  step,
                  attempt: 'primary',
                  output_schema_provided: true,
                },
                observability: stepObservability(
                  input.observability,
                  step,
                  'model',
                  'primary',
                ),
              },
              async () =>
                config.model.generateJson({
                  taskType: input.taskType,
                  instructions,
                  input: modelInput,
                  outputSchema: actionSchema,
                  cacheablePrefix: input.cacheablePrefix,
                  promptCache: input.promptCache,
                  correlationId: input.correlationId
                    ? `${input.correlationId}:step:${step}`
                    : undefined,
                  attachments,
                  observability: stepObservability(
                    input.observability,
                    step,
                    'model',
                    'primary',
                  ),
                }),
            ),
            input.modelStepTimeoutMs ?? input.stepTimeoutMs ?? remainingMs,
            'agent_model_step_timeout',
          ),
        );
        generated = generatedResult.output;
        generatedRawText = generatedResult.rawText;
        generatedStopReason = generatedResult.stopReason;
        recordModelUsage(modelUsages, generatedResult.modelUsage);
        promptMetrics = attachModelUsagePromptMetrics(
          promptMetrics,
          generatedResult.modelUsage,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message !== 'agent_model_step_timeout' ||
          !input.projectStepStateForModel
        ) {
          throw error;
        }
        const retryModelInput = await buildAgentModelInput(input, {
          step,
          state,
          stepTools,
          attempt: 'timeout_retry',
          error: message,
        });
        const retryPromptMetrics = buildAgentPromptMetrics({
          instructions,
          input: retryModelInput,
          outputSchema: actionSchema,
          attachments,
        });
        const retryPromptMetricsWithCache = attachPromptCacheRequestMetrics(
          retryPromptMetrics,
          input,
        );
        await writeAgentModelTrace(traceDir, {
          kind: 'model_input_timeout_retry',
          taskRunId,
          taskType: input.taskType,
          correlationId: input.correlationId ?? null,
          step,
          createdAt: new Date().toISOString(),
          instructions,
          modelInput: retryModelInput,
          outputSchema: actionSchema,
          attachments: traceAttachments,
          promptMetrics: retryPromptMetricsWithCache,
          previousError: message,
        });
        modelInput = retryModelInput;
        promptMetrics = retryPromptMetricsWithCache;
        const generatedResult = unwrapStructuredJsonModelProviderResult(
          await runWithOptionalTimeout(
            observeGantryWorkflowSpan(
              {
                operationName: 'agent_step.model_timeout_retry',
                costStage: 'agent.step',
                taskType: input.taskType,
                correlationId: input.correlationId ?? null,
                input: { step, attempt: 'timeout_retry', promptMetrics },
                output: (result: unknown) =>
                  summarizeAgentObservation(asRecord(result) ?? {}),
                metadata: {
                  step,
                  attempt: 'timeout_retry',
                  previous_error: message,
                  output_schema_provided: true,
                },
                observability: stepObservability(
                  input.observability,
                  step,
                  'model',
                  'timeout_retry',
                ),
              },
              async () =>
                config.model.generateJson({
                  taskType: input.taskType,
                  instructions,
                  input: modelInput,
                  outputSchema: actionSchema,
                  cacheablePrefix: input.cacheablePrefix,
                  promptCache: input.promptCache,
                  correlationId: input.correlationId
                    ? `${input.correlationId}:step:${step}:timeout_retry`
                    : undefined,
                  attachments,
                  observability: stepObservability(
                    input.observability,
                    step,
                    'model',
                    'timeout_retry',
                  ),
                }),
            ),
            input.modelStepTimeoutMs ?? input.stepTimeoutMs ?? remainingMs,
            'agent_model_step_timeout',
          ),
        );
        generated = generatedResult.output;
        generatedRawText = generatedResult.rawText;
        generatedStopReason = generatedResult.stopReason;
        recordModelUsage(modelUsages, generatedResult.modelUsage);
        promptMetrics = attachModelUsagePromptMetrics(
          promptMetrics,
          generatedResult.modelUsage,
        );
      }
      const stopError = readStructuredModelStopError(generatedStopReason);
      if (stopError) {
        modelOutputFailure = {
          code: stopError,
          details: { stopReason: generatedStopReason },
        };
      } else {
        try {
          action = generatedRawText
            ? parseCompleteJsonRecord(generatedRawText)
            : typeof generated === 'string'
              ? parseCompleteJsonRecord(generated)
              : asRecord(generated);
          if (!action)
            throw new Error(
              'Structured task model output must be a JSON object.',
            );
        } catch (error) {
          modelOutputFailure = {
            code: 'model_output_parse_invalid',
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      if (action && !validateAction(action)) {
        modelOutputFailure = {
          code: 'model_output_schema_invalid',
          details: { schemaErrors: formatSchemaErrors(validateAction.errors) },
        };
      }
      await writeAgentModelTrace(traceDir, {
        kind: 'model_output',
        taskRunId,
        taskType: input.taskType,
        correlationId: input.correlationId ?? null,
        step,
        createdAt: new Date().toISOString(),
        rawOutput: generatedRawText ?? generated,
        parsedAction: action,
        modelOutputFailure,
        promptMetrics,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeAgentModelTrace(traceDir, {
        kind: 'model_error',
        taskRunId,
        taskType: input.taskType,
        correlationId: input.correlationId ?? null,
        step,
        createdAt: new Date().toISOString(),
        error: message,
        promptMetrics,
      });
      recordAgentMemoryObservation(state, {
        step,
        toolName: 'model',
        actionInput: null,
        observation: { status: 'failed', error: message },
        status: 'failed',
        error: message,
      });
      await recordStep({
        step,
        actionType: 'model',
        status: 'failed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        error: message,
        promptMetrics,
      });
      return await finish(
        'failed',
        { status: 'failed', error: message },
        null,
        message,
      );
    }

    if (modelOutputFailure) {
      consecutiveModelOutputFailures += 1;
      const terminal = consecutiveModelOutputFailures >= 2 || step >= maxSteps;
      const error =
        consecutiveModelOutputFailures >= 2
          ? `${modelOutputFailure.code}_after_repair`
          : modelOutputFailure.code;
      state.recoveryHint = {
        error: modelOutputFailure.code,
        details: modelOutputFailure.details ?? null,
        instruction:
          'Return one complete JSON action matching the supplied schema. Keep it compact and do not include prose or markdown.',
      };
      recordAgentMemoryObservation(state, {
        step,
        toolName: 'model',
        actionInput: null,
        observation: {
          status: 'failed',
          error,
          recoveryHint: state.recoveryHint,
        },
        status: 'failed',
        error,
      });
      await recordStep({
        step,
        actionType: modelOutputFailure.code,
        status: 'failed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        observation: {
          status: 'failed',
          error,
          recoveryHint: state.recoveryHint,
        },
        error,
        promptMetrics,
      });
      if (!terminal) continue;
      return await finish('failed', { status: 'failed', error }, null, error);
    }
    if (!action) {
      const error = 'model_output_parse_invalid';
      return await finish('failed', { status: 'failed', error }, null, error);
    }

    consecutiveModelOutputFailures = 0;
    const parsed = parseGenericAgentAction(action);
    mergeModelProgressIntoAgentMemory(state, step, parsed);
    const progressTrace = {
      previousGoalEvaluation: parsed.previousGoalEvaluation ?? null,
      memoryUpdate: parsed.memoryUpdate ?? null,
      nextGoal: parsed.nextGoal ?? null,
    };
    if (parsed.action === 'final') {
      const output = parsed.output;
      const finalValidation = await validateFinalOutput({
        step,
        output,
        source: 'model_final',
      });
      if (!finalValidation.accepted) {
        const validationObservation = applyFinalValidationRejection({
          step,
          source: 'model_final',
          validation: finalValidation,
        });
        await recordStep({
          step,
          actionType: 'final',
          status: 'failed',
          startedAt: stepStartedIso,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - stepStartedAt,
          error: finalValidation.reason ?? 'final_validation_rejected',
          observation: validationObservation,
          promptMetrics,
          auditNote: parsed.auditNote,
          whyThisStep: parsed.whyThisStep,
          expectedOutcome: parsed.expectedOutcome,
          nextIfFails: parsed.nextIfFails,
          visualSummary: parsed.visualSummary,
          visibleTarget: parsed.visibleTarget,
          whyThisAction: parsed.whyThisAction,
          expectedStateChange: parsed.expectedStateChange,
          fallbackIfWrong: parsed.fallbackIfWrong,
          ...progressTrace,
        });
        continue;
      }
      recordAgentMemoryObservation(state, {
        step,
        toolName: 'model_final',
        actionInput: null,
        observation: output,
        status: 'completed',
      });
      await recordStep({
        step,
        actionType: 'final',
        status: 'completed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        observation: {
          ...summarizeAgentObservation(output),
        },
        promptMetrics,
        auditNote: parsed.auditNote,
        whyThisStep: parsed.whyThisStep,
        expectedOutcome: parsed.expectedOutcome,
        nextIfFails: parsed.nextIfFails,
        visualSummary: parsed.visualSummary,
        visibleTarget: parsed.visibleTarget,
        whyThisAction: parsed.whyThisAction,
        expectedStateChange: parsed.expectedStateChange,
        fallbackIfWrong: parsed.fallbackIfWrong,
        ...progressTrace,
      });
      const status =
        output.status === 'needs_review' || output.status === 'failed'
          ? output.status
          : 'completed';
      return await finish(status, output);
    }

    if (parsed.action === 'needs_input') {
      await recordStep({
        step,
        actionType: 'needs_input',
        status: 'completed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        observation: { reason: parsed.reason ?? null },
        promptMetrics,
        auditNote: parsed.auditNote,
        whyThisStep: parsed.whyThisStep,
        expectedOutcome: parsed.expectedOutcome,
        nextIfFails: parsed.nextIfFails,
        visualSummary: parsed.visualSummary,
        visibleTarget: parsed.visibleTarget,
        whyThisAction: parsed.whyThisAction,
        expectedStateChange: parsed.expectedStateChange,
        fallbackIfWrong: parsed.fallbackIfWrong,
        ...progressTrace,
      });
      return await finish('needs_review', {
        status: 'needs_review',
        reason: parsed.reason ?? 'agent_requested_input',
      });
    }

    const stepToolMap = new Map(stepTools.map((tool) => [tool.name, tool]));
    const tool = parsed.toolName ? stepToolMap.get(parsed.toolName) : undefined;
    if (!tool) {
      const message = `Unknown agent tool: ${parsed.toolName ?? ''}`;
      recordAgentMemoryObservation(state, {
        step,
        toolName: parsed.toolName ?? 'unknown_tool',
        actionInput: parsed.input,
        observation: { status: 'failed', error: message },
        status: 'failed',
        error: message,
      });
      await recordStep({
        step,
        actionType: 'call_tool',
        toolName: parsed.toolName ?? null,
        status: 'failed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        error: message,
        promptMetrics,
        actionInput: parsed.input,
        auditNote: parsed.auditNote,
        whyThisStep: parsed.whyThisStep,
        expectedOutcome: parsed.expectedOutcome,
        nextIfFails: parsed.nextIfFails,
        visualSummary: parsed.visualSummary,
        visibleTarget: parsed.visibleTarget,
        whyThisAction: parsed.whyThisAction,
        expectedStateChange: parsed.expectedStateChange,
        fallbackIfWrong: parsed.fallbackIfWrong,
        ...progressTrace,
      });
      return await finish(
        'failed',
        { status: 'failed', error: message },
        null,
        message,
      );
    }

    if (await isCancelled(step, 'before_tool', tool.name)) {
      recordAgentMemoryObservation(state, {
        step,
        toolName: tool.name,
        actionInput: parsed.input,
        observation: {
          status: 'cancelled',
          reason: 'agent_task_cancelled_before_tool',
        },
        status: 'skipped',
      });
      await recordStep({
        step,
        actionType: 'call_tool',
        toolName: tool.name,
        status: 'skipped',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        observation: {
          status: 'cancelled',
          reason: 'agent_task_cancelled_before_tool',
        },
        promptMetrics,
        actionInput: summarizeAgentObservation(parsed.input),
        auditNote: parsed.auditNote,
        whyThisStep: parsed.whyThisStep,
        expectedOutcome: parsed.expectedOutcome,
        nextIfFails: parsed.nextIfFails,
        visualSummary: parsed.visualSummary,
        visibleTarget: parsed.visibleTarget,
        whyThisAction: parsed.whyThisAction,
        expectedStateChange: parsed.expectedStateChange,
        fallbackIfWrong: parsed.fallbackIfWrong,
        ...progressTrace,
      });
      return await finish(
        'failed',
        { status: 'cancelled', reason: 'agent_task_cancelled' },
        null,
        'agent_task_cancelled',
      );
    }

    try {
      await writeAgentModelTrace(traceDir, {
        kind: 'tool_input',
        taskRunId,
        taskType: input.taskType,
        correlationId: input.correlationId ?? null,
        step,
        createdAt: new Date().toISOString(),
        toolName: tool.name,
        input: parsed.input,
        progressTrace,
      });
      const observation = await runWithOptionalTimeout(
        observeGantryWorkflowSpan(
          {
            operationName: 'agent_step.tool_call',
            costStage: 'agent.tool_call',
            taskType: input.taskType,
            correlationId: input.correlationId ?? null,
            input: {
              step,
              toolName: tool.name,
              actionInput: summarizeAgentObservation(parsed.input),
            },
            output: (result: Record<string, unknown>) =>
              summarizeAgentObservation(result),
            metadata: {
              step,
              tool_name: tool.name,
            },
            observability: stepObservability(
              input.observability,
              step,
              'tool',
              tool.name,
            ),
          },
          async () =>
            Promise.resolve(
              tool.execute(parsed.input, {
                taskType: input.taskType,
                correlationId: input.correlationId,
                step,
                state,
                observability: stepObservability(
                  input.observability,
                  step,
                  'tool',
                  tool.name,
                ),
              }),
            ),
        ),
        input.toolStepTimeoutMs ?? input.stepTimeoutMs ?? remainingMs,
        `agent_tool_timeout:${tool.name}`,
      );
      await writeAgentModelTrace(traceDir, {
        kind: 'tool_output',
        taskRunId,
        taskType: input.taskType,
        correlationId: input.correlationId ?? null,
        step,
        createdAt: new Date().toISOString(),
        toolName: tool.name,
        input: parsed.input,
        observation,
        compactObservation: summarizeAgentObservation(observation),
      });
      if (await isCancelled(step, 'after_tool', tool.name)) {
        recordAgentMemoryObservation(state, {
          step,
          toolName: tool.name,
          actionInput: parsed.input,
          observation: {
            status: 'cancelled',
            reason: 'agent_task_cancelled_after_tool',
          },
          status: 'skipped',
        });
        await recordStep({
          step,
          actionType: 'call_tool',
          toolName: tool.name,
          status: 'skipped',
          startedAt: stepStartedIso,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - stepStartedAt,
          observation: {
            status: 'cancelled',
            reason: 'agent_task_cancelled_after_tool',
          },
          promptMetrics,
          actionInput: summarizeAgentObservation(parsed.input),
          auditNote: parsed.auditNote,
          whyThisStep: parsed.whyThisStep,
          expectedOutcome: parsed.expectedOutcome,
          nextIfFails: parsed.nextIfFails,
          visualSummary: parsed.visualSummary,
          visibleTarget: parsed.visibleTarget,
          whyThisAction: parsed.whyThisAction,
          expectedStateChange: parsed.expectedStateChange,
          fallbackIfWrong: parsed.fallbackIfWrong,
          ...progressTrace,
        });
        return await finish(
          'failed',
          { status: 'cancelled', reason: 'agent_task_cancelled' },
          null,
          'agent_task_cancelled',
        );
      }
      const compactObservation = summarizeAgentObservation(observation);
      recordAgentMemoryObservation(state, {
        step,
        toolName: tool.name,
        actionInput: parsed.input,
        observation,
        status: 'completed',
      });
      const observationRecord = asRecord(compactObservation) ?? {};
      const readinessObservation =
        asRecord(observationRecord.readinessValidation) ??
        asRecord(observationRecord.readiness) ??
        null;
      if (readinessObservation) state.latestReadiness = readinessObservation;
      const toolError = readOptionalString(observationRecord.error);
      const noProgressReason = readNoProgressReason(observationRecord);
      if (toolError || noProgressReason) {
        const repeatKey = `${tool.name}:${toolError ?? noProgressReason}`;
        const repeatCount = (repeatedFailures.get(repeatKey) ?? 0) + 1;
        repeatedFailures.set(repeatKey, repeatCount);
        state.recoveryHint = {
          repeatKey,
          repeatCount,
          toolName: tool.name,
          error: toolError ?? null,
          noProgressReason: noProgressReason ?? null,
          instruction:
            repeatCount >= 2
              ? 'Do not repeat the same failing or no-progress tool payload. Use the last observation/readiness guidance to gather the missing evidence or choose a different route/action.'
              : toolError
                ? 'If this tool failed, correct the payload using the tool observation before retrying.'
                : 'This tool made no useful progress. Inspect the current state, choose a different safe action, or call a probe/recovery tool before retrying.',
        };
      } else {
        state.recoveryHint = null;
      }
      const observations = Array.isArray(state.observations)
        ? [...state.observations]
        : [];
      observations.push({
        step,
        toolName: tool.name,
        input: parsed.input,
        observation: compactObservation,
        auditNote: parsed.auditNote ?? null,
        whyThisStep: parsed.whyThisStep ?? null,
        visualSummary: parsed.visualSummary ?? null,
        visibleTarget: parsed.visibleTarget ?? null,
        whyThisAction: parsed.whyThisAction ?? null,
        expectedStateChange: parsed.expectedStateChange ?? null,
        fallbackIfWrong: parsed.fallbackIfWrong ?? null,
      });
      state.observations = observations;
      state.lastObservation = compactObservation;
      await recordStep({
        step,
        actionType: 'call_tool',
        toolName: tool.name,
        status: 'completed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        observation: compactObservation,
        promptMetrics,
        actionInput: summarizeAgentObservation(parsed.input),
        auditNote: parsed.auditNote,
        whyThisStep: parsed.whyThisStep,
        expectedOutcome: parsed.expectedOutcome,
        nextIfFails: parsed.nextIfFails,
        visualSummary: parsed.visualSummary,
        visibleTarget: parsed.visibleTarget,
        whyThisAction: parsed.whyThisAction,
        expectedStateChange: parsed.expectedStateChange,
        fallbackIfWrong: parsed.fallbackIfWrong,
        ...progressTrace,
      });
      const finalOutput = asRecord(observation.finalOutput);
      if (finalOutput) {
        const finalValidation = await validateFinalOutput({
          step,
          output: finalOutput,
          source: 'tool_final_output',
          toolName: tool.name,
        });
        if (!finalValidation.accepted) {
          const validationObservation = applyFinalValidationRejection({
            step,
            source: 'tool_final_output',
            toolName: tool.name,
            validation: finalValidation,
          });
          await recordStep({
            step,
            actionType: 'final_validation',
            toolName: tool.name,
            status: 'failed',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 0,
            error: finalValidation.reason ?? 'final_validation_rejected',
            observation: validationObservation,
            promptMetrics: null,
            actionInput: null,
            auditNote: 'Tool final output rejected by task-specific validator.',
            ...progressTrace,
          });
          continue;
        }
        recordAgentMemoryObservation(state, {
          step,
          toolName: tool.name,
          actionInput: parsed.input,
          observation: finalOutput,
          status: 'completed',
        });
        const status =
          finalOutput.status === 'needs_review' ||
          finalOutput.status === 'failed'
            ? finalOutput.status
            : 'completed';
        return await finish(status, finalOutput);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeAgentModelTrace(traceDir, {
        kind: 'tool_error',
        taskRunId,
        taskType: input.taskType,
        correlationId: input.correlationId ?? null,
        step,
        createdAt: new Date().toISOString(),
        toolName: tool.name,
        input: parsed.input,
        error: message,
      });
      recordAgentMemoryObservation(state, {
        step,
        toolName: tool.name,
        actionInput: parsed.input,
        observation: { status: 'failed', error: message },
        status: 'failed',
        error: message,
      });
      await recordStep({
        step,
        actionType: 'call_tool',
        toolName: tool.name,
        status: 'failed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        error: message,
        promptMetrics,
        actionInput: summarizeAgentObservation(parsed.input),
        auditNote: parsed.auditNote,
        whyThisStep: parsed.whyThisStep,
        expectedOutcome: parsed.expectedOutcome,
        nextIfFails: parsed.nextIfFails,
        visualSummary: parsed.visualSummary,
        visibleTarget: parsed.visibleTarget,
        whyThisAction: parsed.whyThisAction,
        expectedStateChange: parsed.expectedStateChange,
        fallbackIfWrong: parsed.fallbackIfWrong,
        ...progressTrace,
      });
      if (
        message.startsWith(`agent_tool_timeout:${tool.name}`) &&
        input.recoverFromToolError
      ) {
        const recovery = await input.recoverFromToolError({
          taskType: input.taskType,
          correlationId: input.correlationId,
          step,
          state,
          toolName: tool.name,
          toolInput: parsed.input,
          error: message,
          tools: stepTools,
        });
        if (recovery) {
          const recoveryTools = recovery.tools ?? [];
          const recoveryInstructions =
            recovery.instructions ??
            [
              input.instructions,
              '',
              'Tool timeout recovery is active.',
              'Do not call tools. Return a final answer using the current state.',
            ].join('\n');
          const recoveryModelInput = await buildAgentModelInput(input, {
            step,
            state,
            stepTools: recoveryTools,
            attempt: recovery.attempt ?? 'tool_error_recovery',
            error: message,
          });
          const recoveryPromptMetrics = buildAgentPromptMetrics({
            instructions: recoveryInstructions,
            input: recoveryModelInput,
            outputSchema: actionSchema,
            attachments: [],
          });
          let recoveryPromptMetricsWithCache = attachPromptCacheRequestMetrics(
            recoveryPromptMetrics,
            input,
          );
          await writeAgentModelTrace(traceDir, {
            kind: 'model_input_tool_error_recovery',
            taskRunId,
            taskType: input.taskType,
            correlationId: input.correlationId ?? null,
            step,
            createdAt: new Date().toISOString(),
            instructions: recoveryInstructions,
            modelInput: recoveryModelInput,
            outputSchema: actionSchema,
            attachments: [],
            promptMetrics: recoveryPromptMetricsWithCache,
            previousError: message,
          });
          try {
            const generatedResult = unwrapStructuredJsonModelProviderResult(
              await runWithOptionalTimeout(
                observeGantryWorkflowSpan(
                  {
                    operationName: 'agent_step.model_tool_error_recovery',
                    costStage: 'agent.step',
                    taskType: input.taskType,
                    correlationId: input.correlationId ?? null,
                    input: {
                      step,
                      attempt: 'tool_error_recovery',
                      promptMetrics: recoveryPromptMetricsWithCache,
                    },
                    output: (result: unknown) =>
                      summarizeAgentObservation(asRecord(result) ?? {}),
                    metadata: {
                      step,
                      attempt: 'tool_error_recovery',
                      previous_error: message,
                      output_schema_provided: true,
                    },
                    observability: stepObservability(
                      input.observability,
                      step,
                      'model',
                      'tool_error_recovery',
                    ),
                  },
                  async () =>
                    config.model.generateJson({
                      taskType: input.taskType,
                      instructions: recoveryInstructions,
                      input: recoveryModelInput,
                      outputSchema: actionSchema,
                      cacheablePrefix: input.cacheablePrefix,
                      promptCache: input.promptCache,
                      correlationId: input.correlationId
                        ? `${input.correlationId}:step:${step}:tool_error_recovery`
                        : undefined,
                      attachments: [],
                      observability: stepObservability(
                        input.observability,
                        step,
                        'model',
                        'tool_error_recovery',
                      ),
                    }),
                ),
                input.modelStepTimeoutMs ?? input.stepTimeoutMs ?? remainingMs,
                'agent_model_step_timeout',
              ),
            );
            const generated = generatedResult.output;
            recordModelUsage(modelUsages, generatedResult.modelUsage);
            recoveryPromptMetricsWithCache = attachModelUsagePromptMetrics(
              recoveryPromptMetricsWithCache,
              generatedResult.modelUsage,
            );
            const stopError = readStructuredModelStopError(
              generatedResult.stopReason,
            );
            if (stopError) throw new Error(stopError, { cause: error });
            const recoveryAction = generatedResult.rawText
              ? parseCompleteJsonRecord(generatedResult.rawText)
              : typeof generated === 'string'
                ? parseCompleteJsonRecord(generated)
                : asRecord(generated);
            if (!recoveryAction || !validateAction(recoveryAction)) {
              throw new Error('model_output_schema_invalid', { cause: error });
            }
            await writeAgentModelTrace(traceDir, {
              kind: 'model_output_tool_error_recovery',
              taskRunId,
              taskType: input.taskType,
              correlationId: input.correlationId ?? null,
              step,
              createdAt: new Date().toISOString(),
              rawOutput: generatedResult.rawText ?? generated,
              parsedAction: recoveryAction,
              promptMetrics: recoveryPromptMetricsWithCache,
              previousError: message,
            });
            const recoveryParsed = parseGenericAgentAction(recoveryAction);
            mergeModelProgressIntoAgentMemory(state, step, recoveryParsed);
            if (recoveryParsed.action === 'final') {
              const recoveryValidation = await validateFinalOutput({
                step,
                output: recoveryParsed.output,
                source: 'model_final',
              });
              if (recoveryValidation.accepted) {
                recordAgentMemoryObservation(state, {
                  step,
                  toolName: 'model_final',
                  actionInput: null,
                  observation: recoveryParsed.output,
                  status: 'completed',
                });
                await recordStep({
                  step,
                  actionType: 'final',
                  status: 'completed',
                  startedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString(),
                  durationMs: 0,
                  observation: summarizeAgentObservation(recoveryParsed.output),
                  promptMetrics: recoveryPromptMetricsWithCache,
                  auditNote: recoveryParsed.auditNote,
                  whyThisStep: recoveryParsed.whyThisStep,
                  expectedOutcome: recoveryParsed.expectedOutcome,
                  nextIfFails: recoveryParsed.nextIfFails,
                  visualSummary: recoveryParsed.visualSummary,
                  visibleTarget: recoveryParsed.visibleTarget,
                  whyThisAction: recoveryParsed.whyThisAction,
                  expectedStateChange: recoveryParsed.expectedStateChange,
                  fallbackIfWrong: recoveryParsed.fallbackIfWrong,
                  previousGoalEvaluation:
                    recoveryParsed.previousGoalEvaluation ?? null,
                  memoryUpdate: recoveryParsed.memoryUpdate ?? null,
                  nextGoal: recoveryParsed.nextGoal ?? null,
                });
                const status =
                  recoveryParsed.output.status === 'needs_review' ||
                  recoveryParsed.output.status === 'failed'
                    ? recoveryParsed.output.status
                    : 'completed';
                return await finish(status, recoveryParsed.output);
              }
              await recordStep({
                step,
                actionType: 'final_validation',
                status: 'failed',
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: 0,
                error: recoveryValidation.reason ?? 'final_validation_rejected',
                observation: applyFinalValidationRejection({
                  step,
                  source: 'model_final',
                  validation: recoveryValidation,
                }),
                promptMetrics: recoveryPromptMetricsWithCache,
                auditNote:
                  'Tool timeout recovery final output rejected by task-specific validator.',
              });
            }
          } catch (recoveryError) {
            const recoveryMessage =
              recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError);
            await writeAgentModelTrace(traceDir, {
              kind: 'model_error_tool_error_recovery',
              taskRunId,
              taskType: input.taskType,
              correlationId: input.correlationId ?? null,
              step,
              createdAt: new Date().toISOString(),
              error: recoveryMessage,
              previousError: message,
              promptMetrics: recoveryPromptMetricsWithCache,
            });
            await recordStep({
              step,
              actionType: 'tool_error_recovery',
              toolName: tool.name,
              status: 'failed',
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: 0,
              error: recoveryMessage,
              observation: {
                status: 'failed',
                originalError: message,
                recoveryError: recoveryMessage,
              },
              promptMetrics: recoveryPromptMetricsWithCache,
            });
          }
        }
      }
      return await finish(
        'failed',
        { status: 'failed', error: message },
        null,
        message,
      );
    }
  }

  warnings.push('agent_task_max_steps_exceeded');
  return await finish(
    'needs_review',
    {
      status: 'needs_review',
      reason: 'agent_task_max_steps_exceeded',
    },
    null,
    'agent_task_max_steps_exceeded',
  );
}

function readNoProgressReason(
  observationRecord: Record<string, unknown>,
): string | null {
  const directReason =
    readOptionalString(observationRecord.noProgressReason) ??
    readOptionalString(observationRecord.no_progress_reason);
  if (observationRecord.noProgress === true) {
    return directReason ?? 'tool_reported_no_progress';
  }
  const progress = asRecord(observationRecord.progress);
  const progressStatus =
    readOptionalString(progress?.status) ??
    readOptionalString(progress?.outcome);
  if (progressStatus === 'no_progress') {
    return (
      readOptionalString(progress?.reason) ??
      directReason ??
      'tool_reported_no_progress'
    );
  }
  const transition =
    asRecord(observationRecord.pageTransition) ??
    asRecord(observationRecord.page_transition);
  const transitionOutcome =
    readOptionalString(transition?.outcome) ??
    readOptionalString(transition?.status);
  if (transitionOutcome === 'no_progress') {
    return (
      readOptionalString(transition?.reason) ??
      readOptionalString(transition?.summary) ??
      directReason ??
      'page_action_no_progress'
    );
  }
  if (
    transition &&
    transition.changed === false &&
    readOptionalString(transition.expectedStateChange)
  ) {
    return (
      readOptionalString(transition.reason) ??
      'page_action_did_not_reach_expected_state'
    );
  }
  return null;
}

function resolveAgentModelTraceDir(input: GantryAgentTaskInput): string | null {
  const baseDir = process.env.AGENT_GANTRY_MODEL_TRACE_DIR?.trim();
  if (!baseDir) return null;
  const safeTask = sanitizeTracePathSegment(input.taskType || 'agent-task');
  const safeCorrelation = sanitizeTracePathSegment(
    input.correlationId ?? randomUUID(),
  );
  return path.resolve(baseDir, safeTask, safeCorrelation);
}

function attachPromptCacheRequestMetrics(
  promptMetrics: Record<string, unknown>,
  input: GantryAgentTaskInput,
): Record<string, unknown> {
  const prefix = input.cacheablePrefix?.trim();
  const promptCache = input.promptCache;
  if (!prefix || promptCache?.enabled !== true) {
    return promptMetrics;
  }
  return {
    ...promptMetrics,
    promptCache: {
      enabled: true,
      ttl: promptCache.ttl ?? '1h',
      prefixHash: promptCache.prefixHash ?? null,
      prefixCharCount: prefix.length,
    },
  };
}

function attachModelUsagePromptMetrics(
  promptMetrics: Record<string, unknown>,
  modelUsage: GantryStructuredModelUsage | null,
): Record<string, unknown> {
  if (!modelUsage) {
    return promptMetrics;
  }
  const promptCache = asRecord(promptMetrics.promptCache);
  if (!promptCache) {
    return promptMetrics;
  }
  return {
    ...promptMetrics,
    promptCache: {
      ...promptCache,
      cacheCreationInputTokens: modelUsage.cacheCreationInputTokens ?? null,
      cacheReadInputTokens: modelUsage.cacheReadInputTokens ?? null,
      cachedTokens: modelUsage.cachedTokens ?? null,
      promptCacheTtl: modelUsage.promptCacheTtl ?? null,
      promptCachePrefixHash:
        modelUsage.promptCachePrefixHash ?? promptCache.prefixHash ?? null,
    },
  };
}

function recordModelUsage(
  usages: GantryStructuredModelUsage[],
  modelUsage: GantryStructuredModelUsage | null,
): void {
  if (modelUsage) {
    usages.push(modelUsage);
  }
}

function stepObservability(
  context: GantryObservabilityContext | null | undefined,
  step: number,
  kind: 'model' | 'tool',
  attemptOrTool: string,
): GantryObservabilityContext | null {
  if (!context) return null;
  return {
    ...context,
    metadata: {
      ...(context.metadata ?? {}),
      agent_step: step,
      agent_step_kind: kind,
      agent_step_detail: attemptOrTool,
    },
  };
}

function aggregateModelUsage(input: {
  readonly usages: readonly GantryStructuredModelUsage[];
  readonly taskType: string;
  readonly correlationId: string | null;
  readonly durationMs: number;
}): GantryStructuredModelUsage | null {
  if (input.usages.length === 0) return null;
  const providers = uniqueDefined(input.usages.map((usage) => usage.provider));
  const models = uniqueDefined(input.usages.map((usage) => usage.model));
  const usageSources = uniqueDefined(
    input.usages.map((usage) => usage.usageSource),
  );
  const promptCacheTtls = uniquePromptCacheTtls(
    input.usages.map((usage) => usage.promptCacheTtl),
  );
  const promptCachePrefixHashes = uniqueDefined(
    input.usages.map((usage) => usage.promptCachePrefixHash),
  );
  const inputTokens = sumOptionalNumbers(
    input.usages.map((usage) => usage.inputTokens),
  );
  const outputTokens = sumOptionalNumbers(
    input.usages.map((usage) => usage.outputTokens),
  );
  const totalTokens =
    sumOptionalNumbers(input.usages.map((usage) => usage.totalTokens)) ??
    addOptionalNumbers(inputTokens, outputTokens);
  const durationMs =
    sumOptionalNumbers(input.usages.map((usage) => usage.durationMs)) ??
    input.durationMs;
  return {
    provider:
      providers.length === 1
        ? providers[0]
        : providers.length > 1
          ? 'mixed'
          : null,
    model: models.length === 1 ? models[0] : models.length > 1 ? 'mixed' : null,
    taskType: input.taskType,
    correlationId: input.correlationId,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: sumOptionalNumbers(
      input.usages.map((usage) => usage.cachedTokens),
    ),
    cacheCreationInputTokens: sumOptionalNumbers(
      input.usages.map((usage) => usage.cacheCreationInputTokens),
    ),
    cacheReadInputTokens: sumOptionalNumbers(
      input.usages.map((usage) => usage.cacheReadInputTokens),
    ),
    promptCacheTtl: promptCacheTtls.length === 1 ? promptCacheTtls[0] : null,
    promptCachePrefixHash:
      promptCachePrefixHashes.length === 1 ? promptCachePrefixHashes[0] : null,
    durationMs,
    usageSource: usageSources.length === 1 ? usageSources[0] : 'mixed',
  };
}

function uniqueDefined(
  values: readonly (string | null | undefined)[],
): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function uniquePromptCacheTtls(
  values: readonly (string | null | undefined)[],
): Array<'5m' | '1h'> {
  return [
    ...new Set(
      values.filter(
        (value): value is '5m' | '1h' => value === '5m' || value === '1h',
      ),
    ),
  ];
}

function sumOptionalNumbers(
  values: readonly (number | null | undefined)[],
): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

function addOptionalNumbers(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

async function writeAgentModelTrace(
  traceDir: string | null,
  event: Record<string, unknown>,
): Promise<void> {
  if (!traceDir) return;
  try {
    await mkdir(traceDir, { recursive: true });
    const step = typeof event.step === 'number' ? event.step : 0;
    const kind = readOptionalString(event.kind) ?? 'event';
    const prefix = `step-${String(step).padStart(3, '0')}-${sanitizeTracePathSegment(kind)}`;
    await appendFile(
      path.join(traceDir, 'events.jsonl'),
      `${JSON.stringify(event)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(traceDir, `${prefix}.json`),
      `${JSON.stringify(event, null, 2)}\n`,
      'utf8',
    );
    if (kind === 'model_input') {
      await writeFile(
        path.join(traceDir, `${prefix}.md`),
        formatModelInputTraceMarkdown(event),
        'utf8',
      );
    }
  } catch {
    // Tracing must never change agent behavior.
  }
}

async function persistTraceAttachments(
  traceDir: string | null,
  step: number,
  attachments: readonly unknown[] | undefined,
): Promise<readonly Record<string, unknown>[]> {
  const records = (attachments ?? []).flatMap((attachment) => {
    const record = asRecord(attachment);
    return record ? [record] : [];
  });
  return await Promise.all(
    records.map(async (record, index) => {
      const base64 = readOptionalString(record.base64);
      const summary: Record<string, unknown> = {
        label: readOptionalString(record.label),
        mimeType: readOptionalString(record.mimeType),
        purpose: readOptionalString(record.purpose),
        sourceStep: record.sourceStep ?? null,
        hasBase64: Boolean(base64),
        base64Chars: base64?.length ?? 0,
        localPath: readOptionalString(record.localPath),
      };
      if (!traceDir || !base64) return summary;
      const mimeType = readOptionalString(record.mimeType) ?? '';
      const extension = traceAttachmentExtension(mimeType);
      const filename = `step-${String(step).padStart(3, '0')}-attachment-${String(index + 1).padStart(2, '0')}${extension}`;
      try {
        await mkdir(traceDir, { recursive: true });
        await writeFile(
          path.join(traceDir, filename),
          Buffer.from(base64, 'base64'),
        );
        return {
          ...summary,
          traceFile: filename,
        };
      } catch {
        return summary;
      }
    }),
  );
}

function traceAttachmentExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('json')) return '.json';
  if (normalized.startsWith('text/')) return '.txt';
  return '.bin';
}

function formatModelInputTraceMarkdown(event: Record<string, unknown>): string {
  const instructions = readOptionalString(event.instructions) ?? '';
  const modelInput = asRecord(event.modelInput) ?? {};
  const outputSchema = asRecord(event.outputSchema) ?? {};
  const attachments = Array.isArray(event.attachments) ? event.attachments : [];
  const promptMetrics = asRecord(event.promptMetrics) ?? {};
  return [
    `# Agent Model Input Step ${event.step ?? ''}`,
    '',
    `- Task: ${event.taskType ?? ''}`,
    `- Correlation: ${event.correlationId ?? ''}`,
    `- Created: ${event.createdAt ?? ''}`,
    '',
    '## Prompt Metrics',
    '',
    fencedJson(promptMetrics),
    '',
    '## Instructions',
    '',
    '```text',
    instructions,
    '```',
    '',
    '## Model Input JSON',
    '',
    fencedJson(modelInput),
    '',
    '## Output Schema JSON',
    '',
    fencedJson(outputSchema),
    '',
    '## Attachment Metadata',
    '',
    fencedJson(attachments),
    '',
  ].join('\n');
}

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

function sanitizeTracePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 160);
  return sanitized || 'trace';
}

function formatSchemaErrors(
  errors: ErrorObject[] | null | undefined,
): Array<Record<string, unknown>> {
  return (errors ?? []).slice(0, 8).map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'schema validation failed',
    params: error.params,
  }));
}

export { summarizeAgentObservation } from './agent-task-runner-helpers.js';

async function buildAgentModelInput(
  input: GantryAgentTaskInput,
  request: {
    readonly step: number;
    readonly state: Record<string, unknown>;
    readonly stepTools: readonly GantryAgentTool[];
    readonly attempt: 'primary' | 'timeout_retry' | 'tool_error_recovery';
    readonly error?: string | null;
  },
) {
  const compactedState = cloneJsonRecord(compactAgentLoopState(request.state));
  const projectedState = input.projectStepStateForModel
    ? await input.projectStepStateForModel({
        taskType: input.taskType,
        correlationId: input.correlationId,
        step: request.step,
        state: compactedState,
        tools: request.stepTools,
        attempt: request.attempt,
        error: request.error ?? null,
      })
    : compactedState;
  return {
    state: cloneJsonRecord(projectedState),
    availableTools: request.stepTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? {},
    })),
  };
}

async function selectToolsForStep(
  input: GantryAgentTaskInput,
  request: {
    readonly step: number;
    readonly maxSteps: number;
    readonly state: Record<string, unknown>;
  },
) {
  if (!input.selectStepTools) return input.tools;
  const selectedNames = await input.selectStepTools({
    taskType: input.taskType,
    correlationId: input.correlationId,
    step: request.step,
    maxSteps: request.maxSteps,
    state: request.state,
    tools: input.tools,
  });
  if (!selectedNames || selectedNames.length === 0) return input.tools;
  const selectedNameSet = new Set(selectedNames);
  return input.tools.filter((tool) => selectedNameSet.has(tool.name));
}
