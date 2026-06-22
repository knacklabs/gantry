/**
 * Gantry DeepAgents (LangChain) Agent Runner
 *
 * Runs as the child agent process for the `deepagents:langchain` execution
 * adapter. Receives full AgentInput JSON via stdin (read until EOF), executes a
 * tool-less DeepAgents run through Gantry's loopback model gateway, and emits
 * provider-neutral runner output frames on stdout (see runner/runner-frame.ts).
 *
 * Input protocol:
 *   Stdin: full agent input JSON (read until EOF)
 *   IPC:   live follow-up messages as JSON files under GANTRY_IPC_INPUT_DIR
 *          ({type:"message", text:"..."}.json); a `_close` sentinel ends it.
 *
 * Stdout protocol: each frame wrapped in OUTPUT_START/OUTPUT_END markers.
 */

import { runDeepAgentTurn } from './deep-agent-runner.js';
import type { OpenRouterProviderPreferences } from './model-factory.js';
import {
  drainIpcInput,
  prepareInteractiveIpcInputDir,
} from '../../../../runner/runner-ipc-input.js';
import { isAbortError, startDeepAgentLiveControl } from './live-control.js';
import { startDeepAgentJobHeartbeat } from './job-heartbeat.js';
import {
  readRunnerStdin,
  writeRunnerFrame,
  type RunnerOutputFrame,
} from '../../../../runner/runner-frame.js';
import {
  createDeepAgentCheckpointTiming,
  DeepAgentSessionStore,
  type DeepAgentCheckpointSaver,
} from './session-store.js';
import type { DeepAgentRunnerInput } from './types.js';
import { nowMs } from '../../../../shared/time/datetime.js';

function log(message: string): void {
  if (process.env.GANTRY_RUNNER_LOG === '1') {
    process.stderr.write(`[deepagents-runner] ${message}\n`);
  }
}

function resolveModelId(agentInput: DeepAgentRunnerInput): string {
  const fromEnv = process.env.GANTRY_DEEPAGENTS_MODEL_ID?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    'DeepAgents runner is missing GANTRY_DEEPAGENTS_MODEL_ID for the resolved model route.',
  );
}

function resolveModelProvider(): string {
  const fromEnv = process.env.GANTRY_DEEPAGENTS_MODEL_PROVIDER?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    'DeepAgents runner is missing GANTRY_DEEPAGENTS_MODEL_PROVIDER for the resolved model route.',
  );
}

// Optional curated context window for empty-profile models. The host projects it
// only when the catalog declares one; absent -> the runner uses the library's
// real model profile (gpt-5.5/gpt-5.4). A non-numeric/<=0 value is ignored.
function resolveMaxInputTokens(): number | undefined {
  const raw = process.env.GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveOpenRouterProviderRouting():
  | OpenRouterProviderPreferences
  | undefined {
  const raw = process.env.GANTRY_DEEPAGENTS_OPENROUTER_PROVIDER_ROUTING?.trim();
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'DeepAgents runner OpenRouter provider routing must be a JSON object.',
    );
  }
  return parsed as OpenRouterProviderPreferences;
}

type DeepAgentTurnOutput = Awaited<ReturnType<typeof runDeepAgentTurn>>;

function runtimeEventsForTurn(
  turn: DeepAgentTurnOutput | undefined,
): Pick<RunnerOutputFrame, 'runtimeEvents'> {
  return turn?.startupRuntimeEvents?.length
    ? { runtimeEvents: turn.startupRuntimeEvents }
    : {};
}

async function runScheduled(agentInput: DeepAgentRunnerInput): Promise<void> {
  // Scheduled jobs are ephemeral: no session persistence (mirrors the Anthropic
  // runner's isScheduledJob path). A diagnostic session id is still emitted.
  const diagnosticSessionId = DeepAgentSessionStore.newSessionId();
  // Emit JOB_HEARTBEAT frames so the host's idle-stall detection and lease
  // activity tracking behave identically to the Anthropic lane for long runs.
  const heartbeat = startDeepAgentJobHeartbeat({
    agentInput,
    writeFrame: writeRunnerFrame,
    getSessionId: () => diagnosticSessionId,
  });
  // Each streamed frame counts as runner activity so a streaming scheduled run
  // is never falsely flagged idle.
  const emit = (frame: RunnerOutputFrame): void => {
    heartbeat.markActivity();
    writeRunnerFrame(frame);
  };
  try {
    const maxInputTokens = resolveMaxInputTokens();
    const openRouterProviderRouting = resolveOpenRouterProviderRouting();
    const turn = await runDeepAgentTurn({
      agentInput,
      provider: resolveModelProvider(),
      modelId: resolveModelId(agentInput),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(openRouterProviderRouting ? { openRouterProviderRouting } : {}),
      newSessionId: diagnosticSessionId,
      includeMemoryContext: true,
      emit,
      log,
      // Long-running tool calls mark heartbeat activity so the scheduled run's
      // lease stays alive instead of being flagged idle mid-tool.
      onToolStart: (toolName) => heartbeat.recordToolActivity(toolName),
    });
    // The single terminal frame (usage/contextUsage) is emitted by the caller so
    // there is exactly one terminal marker per turn (the normalizer streams
    // deltas only).
    emit({
      status: 'success',
      result: turn.terminalResult,
      newSessionId: diagnosticSessionId,
      ...(turn.terminalUsage ? { usage: turn.terminalUsage } : {}),
      ...(turn.terminalContextUsage
        ? { contextUsage: turn.terminalContextUsage }
        : {}),
      ...runtimeEventsForTurn(turn),
    });
    heartbeat.stop();
  } catch (err) {
    heartbeat.stop();
    writeRunnerFrame({
      status: 'error',
      result: null,
      newSessionId: diagnosticSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

async function runInteractive(agentInput: DeepAgentRunnerInput): Promise<void> {
  prepareInteractiveIpcInputDir();

  const sessionId =
    agentInput.sessionId ?? DeepAgentSessionStore.newSessionId();
  let checkpointer: DeepAgentCheckpointSaver | undefined;
  const checkpointTiming = createDeepAgentCheckpointTiming({ nowMs });
  // Live-turn control parity: the shared signal pump watches the neutral
  // IPC-input dir for a `_close` sentinel (host /stop or close-stdin) and for
  // mid-stream follow-up messages. A close aborts the in-flight LangGraph stream
  // via its signal.
  const liveControl = startDeepAgentLiveControl({ log });
  try {
    if (!agentInput.deepAgentCheckpointer) {
      throw new Error(
        'DeepAgents runner is missing Postgres checkpointer configuration for live session persistence.',
      );
    }
    const store = new DeepAgentSessionStore(
      agentInput.deepAgentCheckpointer,
      checkpointTiming,
    );
    // Live continuity: resume the adapter-private LangGraph checkpoint if one
    // was passed, else start a fresh thread. A missing Postgres checkpoint
    // throws here and surfaces as the host's stale-session retry
    // (isMissingProviderSessionError) before any session frame is emitted, so
    // the host does not adopt a bogus id.
    checkpointer = agentInput.sessionId
      ? await store.load(agentInput.sessionId)
      : await store.create(sessionId);
    // The host recomputes memory before every runner spawn. Inject it on the
    // first turn even for resumed checkpoints, then avoid repeating the same
    // block for follow-up turns inside this process.
    let includeMemoryContext = true;
    // Emit the session id as soon as the resume is validated so the host
    // persists the provider session before the run completes (launchd restarts
    // can kill an active run mid-stream). This is a standalone session-init
    // frame (`sessionInit: true`), NOT a turn-complete marker: the host's
    // isAgentTurnCompleteMarker excludes it, so the turn is not reported done at
    // its very start (R1). The host still persists the id (it reads newSessionId
    // via providerSessionExternalSessionId).
    writeRunnerFrame({
      status: 'success',
      result: null,
      newSessionId: sessionId,
      sessionInit: true,
    });

    // Follow-ups already queued before the turn started are appended to the
    // first prompt (pre-existing one-shot drain). Mid-stream follow-ups are
    // buffered by the live-control loop and drive additional turns below.
    let pendingFollowups = drainIpcInput(log);

    // Run one or more turns: each turn streams deltas until completion or until
    // STOP aborts it. Exactly ONE terminal marker frame is emitted per
    // user-visible turn — the normalizer streams deltas only and returns the
    // terminal payload; this loop emits the single terminal frame, folding in
    // the continuation/stop decision (R2/R3), mirroring the Anthropic
    // query-loop's per-result frame.
    let firstTurn = true;
    for (;;) {
      const followupText = pendingFollowups.join('\n');
      const turnInput =
        pendingFollowups.length > 0
          ? {
              ...agentInput,
              prompt: firstTurn
                ? `${agentInput.prompt}\n${followupText}`
                : followupText,
            }
          : agentInput;
      pendingFollowups = [];
      firstTurn = false;

      let stoppedThisTurn = false;
      let turn: Awaited<ReturnType<typeof runDeepAgentTurn>> | undefined;
      try {
        const maxInputTokens = resolveMaxInputTokens();
        const openRouterProviderRouting = resolveOpenRouterProviderRouting();
        turn = await runDeepAgentTurn({
          agentInput: turnInput,
          provider: resolveModelProvider(),
          modelId: resolveModelId(agentInput),
          ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
          ...(openRouterProviderRouting ? { openRouterProviderRouting } : {}),
          newSessionId: sessionId,
          threadId: sessionId,
          checkpointer,
          checkpointTiming,
          includeMemoryContext,
          emit: writeRunnerFrame,
          log,
          signal: liveControl.signal,
        });
        includeMemoryContext = false;
      } catch (err) {
        // A close-driven abort is a graceful stop, not a failure.
        if (liveControl.closed() && isAbortError(err)) {
          stoppedThisTurn = true;
        } else {
          throw err;
        }
      }

      // R4: force a final synchronous disk drain right now so a follow-up that
      // landed after the last poll tick but before this break decision is folded
      // into the buffer (the poll timers may not have ticked again). R5: this
      // also observes a `_close` that landed in the same window, so a late close
      // takes the close-path below instead of being lost.
      liveControl.drainNow();

      // R3/R5: a close-driven termination (STOP or close-stdin) ends the turn
      // WITHOUT emitting a completion marker, mirroring the Anthropic lane which
      // returns on closedDuringQuery with no final frame. The host settles the
      // turn on process exit (stopRequested -> error frame, or streamed-success
      // on a plain close-stdin). Re-checking closed() here folds a late close
      // (drained just above) into the same no-marker path.
      if (stoppedThisTurn || liveControl.closed()) {
        liveControl.stop();
        return;
      }

      const moreFollowups = liveControl.takeBufferedFollowups();
      if (moreFollowups.length > 0) {
        // Continue with the buffered follow-up(s) as a fresh turn. The terminal
        // frame for THIS turn carries `continuedByFollowup` (single marker) so
        // the host continues the run instead of completing+dequeuing it.
        pendingFollowups = moreFollowups;
        writeRunnerFrame({
          status: 'success',
          result: turn?.terminalResult ?? null,
          newSessionId: sessionId,
          continuedByFollowup: true,
          ...(turn?.terminalUsage ? { usage: turn.terminalUsage } : {}),
          ...(turn?.terminalContextUsage
            ? { contextUsage: turn.terminalContextUsage }
            : {}),
          ...runtimeEventsForTurn(turn),
        });
        continue;
      }

      // Single terminal marker for the final turn: the run is complete.
      liveControl.stop();
      writeRunnerFrame({
        status: 'success',
        result: turn?.terminalResult ?? null,
        newSessionId: sessionId,
        ...(turn?.terminalUsage ? { usage: turn.terminalUsage } : {}),
        ...(turn?.terminalContextUsage
          ? { contextUsage: turn.terminalContextUsage }
          : {}),
        ...runtimeEventsForTurn(turn),
      });
      break;
    }
  } catch (err) {
    liveControl.stop();
    writeRunnerFrame({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  } finally {
    if (checkpointer) await checkpointer.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  let agentInput: DeepAgentRunnerInput;
  try {
    const stdinData = await readRunnerStdin();
    agentInput = JSON.parse(stdinData) as DeepAgentRunnerInput;
    log(`Received input for group: ${agentInput.workspaceFolder}`);
  } catch (err) {
    writeRunnerFrame({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  if (agentInput.isScheduledJob) {
    await runScheduled(agentInput);
    return;
  }
  await runInteractive(agentInput);
}

void main();
