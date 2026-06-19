import { randomUUID } from 'node:crypto';
import type {
  GantryAgentTaskCancellationRequest,
  GantryAgentTaskInput,
  GantryAgentTaskResult,
  GantryAgentTaskStep,
  StructuredModelTaskRunnerConfig,
  StructuredJsonModelProvider,
} from '../shared/types.js';
import { asRecord, parseJsonRecord } from '../shared/helpers.js';
import {
  buildAgentPromptMetrics,
  buildGenericAgentActionSchema,
  buildGenericAgentStepInstructions,
  cloneJsonRecord,
  compactAgentLoopState,
  normalizeAgentMaxSteps,
  parseGenericAgentAction,
  readAgentStepAttachments,
  readOptionalString,
  readValidationReport,
  resolveAgentDeadlineMs,
  runWithOptionalTimeout,
  summarizeAgentObservation,
} from './agent-task-runner-helpers.js';

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
  const toolMap = new Map(input.tools.map((tool) => [tool.name, tool]));
  const repeatedFailures = new Map<string, number>();
  const state: Record<string, unknown> = {
    input: input.input,
    observations: [],
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

  const finish = async (
    status: GantryAgentTaskResult['status'],
    output: Record<string, unknown>,
    validationReport?: Record<string, unknown> | null,
    error?: string | null,
  ): Promise<GantryAgentTaskResult> => {
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
    let action: Record<string, unknown>;
    let promptMetrics: Record<string, unknown> | null = null;
    try {
      const instructions = buildGenericAgentStepInstructions(input, step);
      const actionSchema = buildGenericAgentActionSchema();
      const modelInput = {
        state: cloneJsonRecord(compactAgentLoopState(state)),
        availableTools: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? {},
        })),
      };
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
      const generated = await runWithOptionalTimeout(
        config.model.generateJson({
          taskType: input.taskType,
          instructions,
          input: modelInput,
          outputSchema: actionSchema,
          correlationId: input.correlationId
            ? `${input.correlationId}:step:${step}`
            : undefined,
          attachments,
        }),
        input.stepTimeoutMs ?? remainingMs,
        'agent_model_step_timeout',
      );
      action =
        typeof generated === 'string'
          ? parseJsonRecord(generated)
          : (generated as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

    const parsed = parseGenericAgentAction(action);
    if (parsed.action === 'final') {
      const output = parsed.output;
      await recordStep({
        step,
        actionType: 'final',
        status: 'completed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        observation: summarizeAgentObservation(output),
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
      });
      return await finish('needs_review', {
        status: 'needs_review',
        reason: parsed.reason ?? 'agent_requested_input',
      });
    }

    if (parsed.action !== 'call_tool') {
      const message = `Unsupported agent action: ${parsed.action}`;
      await recordStep({
        step,
        actionType: parsed.action,
        status: 'failed',
        startedAt: stepStartedIso,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        error: message,
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
      });
      return await finish(
        'failed',
        { status: 'failed', error: message },
        null,
        message,
      );
    }

    const tool = parsed.toolName ? toolMap.get(parsed.toolName) : undefined;
    if (!tool) {
      const message = `Unknown agent tool: ${parsed.toolName ?? ''}`;
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
      });
      return await finish(
        'failed',
        { status: 'failed', error: message },
        null,
        message,
      );
    }

    if (await isCancelled(step, 'before_tool', tool.name)) {
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
      });
      return await finish(
        'failed',
        { status: 'cancelled', reason: 'agent_task_cancelled' },
        null,
        'agent_task_cancelled',
      );
    }

    try {
      const observation = await runWithOptionalTimeout(
        Promise.resolve(
          tool.execute(parsed.input, {
            taskType: input.taskType,
            correlationId: input.correlationId,
            step,
            state,
          }),
        ),
        input.stepTimeoutMs ?? remainingMs,
        `agent_tool_timeout:${tool.name}`,
      );
      if (await isCancelled(step, 'after_tool', tool.name)) {
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
        });
        return await finish(
          'failed',
          { status: 'cancelled', reason: 'agent_task_cancelled' },
          null,
          'agent_task_cancelled',
        );
      }
      const compactObservation = summarizeAgentObservation(observation);
      const observationRecord = asRecord(compactObservation) ?? {};
      const readinessObservation =
        asRecord(observationRecord.readinessValidation) ??
        asRecord(observationRecord.readiness) ??
        null;
      if (readinessObservation) state.latestReadiness = readinessObservation;
      const toolError = readOptionalString(observationRecord.error);
      if (toolError) {
        const repeatKey = `${tool.name}:${toolError}`;
        const repeatCount = (repeatedFailures.get(repeatKey) ?? 0) + 1;
        repeatedFailures.set(repeatKey, repeatCount);
        state.recoveryHint = {
          repeatKey,
          repeatCount,
          toolName: tool.name,
          error: toolError,
          instruction:
            repeatCount >= 2
              ? 'Do not repeat the same failing tool payload. Use the last observation/readiness guidance to gather the missing evidence or call the required setter with corrected evidence.'
              : 'If this tool failed, correct the payload using the tool observation before retrying.',
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
      });
      const finalOutput = asRecord(observation.finalOutput);
      if (finalOutput) {
        const status =
          finalOutput.status === 'needs_review' ||
          finalOutput.status === 'failed'
            ? finalOutput.status
            : 'completed';
        return await finish(status, finalOutput);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      });
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

export { summarizeAgentObservation } from './agent-task-runner-helpers.js';
