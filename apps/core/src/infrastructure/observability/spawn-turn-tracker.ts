import { randomUUID } from 'node:crypto';

import {
  contentCaptureEnabled,
  startTurnSpan,
  tracingEnabled,
  TRACE_CONTENT_MAX_CHARS,
} from './tracing.js';

// Structural mirrors of the runtime's AgentInput/AgentOutput — this module
// must not import runtime types (layer boundary), and only reads these
// fields.
interface TurnInputLike {
  runId?: string;
  appId?: string;
  agentId?: string;
  chatJid?: string;
  threadId?: string;
  jobId?: string;
  memoryUserId?: string;
  prompt: string;
}

interface TurnFrameLike {
  status: string;
  result: string | null;
  error?: string;
  continuedByFollowup?: boolean;
}

export interface SpawnTurnTracker<F extends TurnFrameLike> {
  correlationId: string;
  onOutput: ((frame: F) => Promise<void>) | undefined;
  finish: (output: F | undefined) => void;
}

// Turn-span lifecycle for a spawned runner process. The correlation id is
// minted here and must also be passed into the credential binding so gateway
// LLM spans parent under this turn. Streamed runs deliver visible text via
// onOutput frames and return a null final result, so frames are accumulated
// (content-capture-gated, bounded) for the span's output preview. A terminal
// frame with continuedByFollowup means the same process starts another
// user-visible turn: the span rotates there so one trace never covers
// multiple turns.
export function createSpawnTurnTracker<F extends TurnFrameLike>(
  agentName: string,
  input: TurnInputLike,
  onOutput: ((frame: F) => Promise<void>) | undefined,
): SpawnTurnTracker<F> {
  const correlationId = input.runId ?? `credential-run:${randomUUID()}`;
  const openTurnSpan = (continuation?: boolean) =>
    startTurnSpan({
      runId: correlationId,
      appId: input.appId,
      agentId: input.agentId,
      agentName,
      conversationId: input.chatJid,
      threadId: input.threadId,
      jobId: input.jobId,
      userId: input.memoryUserId,
      ...(continuation ? { continuation } : {}),
    });
  let turnSpan = openTurnSpan();
  turnSpan.setInput(input.prompt);
  const captureTurnContent = contentCaptureEnabled();
  let streamedTurnOutput = '';
  // Set by finish(): late queued callbacks (runner resolved while its output
  // chain was still draining) must not accumulate into or rotate a span
  // that already ended — a late rotation would orphan a registry entry.
  let closed = false;
  const tracedOnOutput =
    onOutput && tracingEnabled()
      ? async (frame: F) => {
          const remaining = TRACE_CONTENT_MAX_CHARS - streamedTurnOutput.length;
          if (
            !closed &&
            captureTurnContent &&
            frame.status !== 'error' &&
            frame.result &&
            remaining > 0
          ) {
            // Slice per frame: one giant structured frame must not bypass
            // the content bound.
            streamedTurnOutput += String(frame.result).slice(0, remaining);
          }
          // Rotate BEFORE awaiting delivery: the runner starts the buffered
          // follow-up immediately after emitting this frame, so a late
          // rotation would parent the next turn's first LLM calls under the
          // previous span (and a rejected callback would skip rotation).
          // ponytail: the host output chain still queues this callback, so a
          // narrow race remains, and the follow-up prompt is runner-side so
          // the rotated span has no input — both marked via
          // gantry.continuation; fixing them needs a synchronous frame hook
          // in agent-spawn-process plus follow-up prompt plumbing.
          if (frame.continuedByFollowup && !closed) {
            if (streamedTurnOutput) turnSpan.setOutput(streamedTurnOutput);
            turnSpan.end('success');
            streamedTurnOutput = '';
            turnSpan = openTurnSpan(true);
          }
          await onOutput(frame);
        }
      : onOutput;
  return {
    correlationId,
    onOutput: tracedOnOutput,
    finish: (output) => {
      closed = true;
      const turnOutput =
        output?.status === 'success'
          ? streamedTurnOutput || output.result || ''
          : '';
      if (turnOutput) turnSpan.setOutput(turnOutput);
      turnSpan.end(
        output?.status === 'success'
          ? 'success'
          : /\bstopped by request\b/i.test(output?.error ?? '')
            ? 'stopped'
            : 'error',
        output?.error,
      );
    },
  };
}
