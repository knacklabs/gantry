import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { normalizeModelUsage } from '../../../../shared/model-usage.js';
import { usageEventIdForMessage } from './query-usage-event-id.js';
import { assertRequiredMcpServerReady } from './mcp-server-validation.js';
import { logUsage } from './usage-logging.js';
import { readContextUsage } from './context-usage.js';
// prettier-ignore
import { hasTopLevelAssistantContent, sdkResultFailureMessage, shouldPrefixVisibleBoundary, topLevelAssistantText } from './sdk-message-output.js';
import { toolSearchStartupRuntimeEvent } from './tool-search-decision.js';
import { runnerStartupTimingRuntimeEvent } from './runner-startup-diagnostic.js';
import { taskRuntimeEvent } from './task-runtime-event.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import type { QueryLoopContext } from './query-loop-phases-setup.js';

type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;
type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
type StreamEventMessage = Extract<SDKMessage, { type: 'stream_event' }>;
type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

function emitStartupTimingDiagnostic(context: QueryLoopContext): void {
  if (context.startupTimingDiagnosticEmitted) return;
  context.startupTimingDiagnosticEmitted = true;
  const capabilities = context.capabilities!;
  writeOutput({
    status: 'success',
    result: null,
    newSessionId: context.newSessionId,
    runtimeEventOnly: true,
    runtimeEvents: [
      runnerStartupTimingRuntimeEvent({
        agentInput: context.agentInput,
        persistSdkSession: context.persistSdkSession,
        resumedSession:
          context.persistSdkSession && Boolean(context.agentInput.sessionId),
        sdkQueryPreparedMs: context.sdkQueryPreparedMs!,
        sdkQueryIteratorMs: context.sdkQueryIteratorMs!,
        firstSdkEventMs: context.firstSdkEventMs,
        providerSessionMs: context.providerSessionMs,
        firstVisibleOutputMs: context.firstVisibleOutputMs,
        firstResultMs: context.firstResultMs,
        messageCount: context.messageCount,
        resultCount: context.resultCount,
        availableToolCount: capabilities.availableTools.length,
        allowedToolCount: capabilities.allowedTools.length,
        disallowedToolCount: capabilities.disallowedTools.length,
        mcpServerCount: Object.keys(capabilities.mcpServers ?? {}).length,
      }),
    ],
  });
}

export function beginQueryLoopMessage(
  context: QueryLoopContext,
  message: SDKMessage,
): void {
  context.messageCount++;
  context.heartbeat.markActivity();
  const msgType =
    message.type === 'system'
      ? `system/${(message as { subtype?: string }).subtype}`
      : message.type;
  // api_retry/auth errors carry the reason in the payload; without it a
  // failing turn logs an undiagnosable retry loop.
  const errorDetail = (message as { error?: unknown; error_status?: unknown })
    .error_status
    ? ` error_status=${String((message as { error_status?: unknown }).error_status)} error=${String((message as { error?: unknown }).error ?? '')}`
    : '';
  log(`[msg #${context.messageCount}] type=${msgType}${errorDetail}`);
  if (!context.firstSdkMessageLogged) {
    context.firstSdkMessageLogged = true;
    context.firstSdkEventMs = context.elapsedMs();
    log(`First SDK message after ${context.firstSdkEventMs}ms`);
  }
}

export function handleAssistantMessage(
  context: QueryLoopContext,
  message: AssistantMessage,
): void {
  if (message.type === 'assistant' && 'uuid' in message) {
    context.lastAssistantUuid = (message as { uuid: string }).uuid;
  }
  if (message.type === 'assistant') {
    if (hasTopLevelAssistantContent(message)) {
      context.sawAssistantContentSinceLastResult = true;
    }
    const assistantText = topLevelAssistantText(message);
    if (assistantText && !context.sawPartialTextSinceLastResult) {
      if (!context.firstTextDeltaLogged) {
        context.firstTextDeltaLogged = true;
        context.firstVisibleOutputMs = context.elapsedMs();
        log(`First SDK assistant text after ${context.firstVisibleOutputMs}ms`);
      }
      const visibleText = shouldPrefixVisibleBoundary(
        context.visibleTextSinceLastResult,
        assistantText,
      )
        ? `\n\n${assistantText}`
        : assistantText;
      context.sawStructuredTextSinceLastResult = true;
      context.pendingStructuredToPartialBoundary = true;
      context.visibleTextSinceLastResult += visibleText;
      writeOutput({
        status: 'success',
        result: visibleText,
        newSessionId: context.newSessionId,
      });
      emitStartupTimingDiagnostic(context);
    }
  }
}

export function handleSystemMessage(
  context: QueryLoopContext,
  message: SystemMessage,
): void {
  if (message.type === 'system' && message.subtype === 'init') {
    context.newSessionId = message.session_id;
    assertRequiredMcpServerReady(message);
    context.providerSessionMs = context.elapsedMs();
    log(
      `Session initialized after ${context.providerSessionMs}ms: provider resume handle received`,
    );
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: context.newSessionId,
      runtimeEventOnly: true,
      runtimeEvents: [
        toolSearchStartupRuntimeEvent({
          agentInput: context.agentInput,
          decision: context.toolSearchDecision!,
        }),
      ],
    });
  }
  if (
    message.type === 'system' &&
    (message as { subtype?: string }).subtype === 'compact_boundary'
  ) {
    log('SDK compact boundary observed');
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: context.newSessionId,
      compactBoundary: true,
    });
  }
  const taskEvent =
    message.type === 'system'
      ? taskRuntimeEvent(context.agentInput, message as Record<string, unknown>)
      : null;
  if (taskEvent) {
    const payload = taskEvent.payload as Record<string, unknown>;
    log(`Task event: type=${taskEvent.eventType} task=${payload.taskId}`);
    writeOutput({
      status: 'success',
      result: null,
      runtimeEventOnly: true,
      runtimeEvents: [taskEvent],
    });
  }
}

export function handleStreamEvent(
  context: QueryLoopContext,
  message: StreamEventMessage,
): void {
  if (message.type === 'stream_event') {
    const event = (message as { event?: unknown }).event as
      | {
          type?: string;
          delta?: { type?: string; text?: string };
        }
      | undefined;
    if (event?.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        if (!context.firstTextDeltaLogged) {
          context.firstTextDeltaLogged = true;
          context.firstVisibleOutputMs = context.elapsedMs();
          log(`First SDK text delta after ${context.firstVisibleOutputMs}ms`);
        }
        const visibleText =
          context.pendingStructuredToPartialBoundary &&
          shouldPrefixVisibleBoundary(
            context.visibleTextSinceLastResult,
            delta.text,
          )
            ? `\n\n${delta.text}`
            : delta.text;
        context.pendingStructuredToPartialBoundary = false;
        context.sawPartialTextSinceLastResult = true;
        context.visibleTextSinceLastResult += visibleText;
        writeOutput({
          status: 'success',
          result: visibleText,
          newSessionId: context.newSessionId,
        });
        if (context.firstVisibleOutputMs !== undefined)
          emitStartupTimingDiagnostic(context);
      }
    }
  }
}

function writeResultOutput(
  context: QueryLoopContext,
  message: ResultMessage,
  textResult: string | null | undefined,
  canUseResultFallback: boolean,
  continuedByFollowup: boolean,
  usage: ReturnType<typeof normalizeModelUsage>,
): void {
  writeOutput({
    status: 'success',
    result: textResult && canUseResultFallback ? textResult : null,
    newSessionId: context.newSessionId,
    ...(context.primeToolAttempts.length > 0
      ? { primeToolAttempts: context.primeToolAttempts }
      : {}),
    ...(continuedByFollowup ? { continuedByFollowup: true } : {}),
    ...(usage
      ? {
          usage,
          usageEventId: usageEventIdForMessage(
            message,
            context.newSessionId ?? context.agentInput.sessionId,
            context.resultCount,
            context.queryRunId,
          ),
        }
      : {}),
  });
}

export async function handleResultMessage(
  context: QueryLoopContext,
  message: ResultMessage,
): Promise<void> {
  if (message.type === 'result') {
    context.resultCount++;
    if (context.resultCount === 1) {
      context.firstResultMs = context.elapsedMs();
      log(`First SDK result after ${context.firstResultMs}ms`);
    }
    const textResult =
      'result' in message ? (message as { result?: string }).result : null;
    const emittedVisibleText =
      context.sawPartialTextSinceLastResult ||
      context.sawStructuredTextSinceLastResult;
    const canUseResultFallback =
      !emittedVisibleText && !context.sawAssistantContentSinceLastResult;
    const resultFailure = sdkResultFailureMessage(message);
    if (resultFailure) {
      throw new Error(resultFailure);
    }
    if (canUseResultFallback && textResult) {
      context.firstVisibleOutputMs ??= context.firstResultMs;
    }
    const loggedResultText = canUseResultFallback ? textResult : null;
    log(
      `Result #${context.resultCount}: subtype=${message.subtype}${loggedResultText ? ` text=${loggedResultText.slice(0, 200)}` : ''}`,
    );
    logUsage(message);
    const usage = normalizeModelUsage({
      message,
      fallbackModel: context.configuredModel,
    });
    const contextUsagePromise = readContextUsage(context.sdkQuery!);
    const nudgeDeliveredThisTurn =
      context.agentInput.isScheduledJob &&
      !context.nudgedScheduledRunToFinish &&
      !context.closedDuringQuery &&
      !/\bOutcome:/i.test(
        context.visibleTextSinceLastResult || textResult || '',
      ) &&
      context.steeringGate.accept(
        'You stopped before finishing. Continue the task now. When you are finished, your final message must begin with a line "Outcome: <one sentence>".',
      ) !== 'closed';
    if (nudgeDeliveredThisTurn) {
      context.nudgedScheduledRunToFinish = true;
      log('Nudged scheduled run to finish: no Outcome line at turn end');
    }
    const continuedByFollowup = context.steeringGate.pendingCount() > 0;
    writeResultOutput(
      context,
      message,
      textResult,
      canUseResultFallback,
      continuedByFollowup,
      usage,
    );
    emitStartupTimingDiagnostic(context);
    context.sawPartialTextSinceLastResult = false;
    context.sawAssistantContentSinceLastResult = false;
    context.sawStructuredTextSinceLastResult = false;
    context.visibleTextSinceLastResult = '';
    context.pendingStructuredToPartialBoundary = false;
    context.steeringGate.markTurnBoundary();
    const scheduledOneShot = context.scheduledOneShot;
    const stream = context.stream;
    if (scheduledOneShot && !nudgeDeliveredThisTurn) stream.end();
    const contextUsage = await contextUsagePromise;
    if (contextUsage) {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: context.newSessionId,
        runtimeEventOnly: true,
        contextUsage,
      });
    }
  }
}
