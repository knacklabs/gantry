import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import type {
  AgentInput,
  AgentOutput,
  spawnAgent,
} from '../runtime/agent-spawn.js';
import type { RunAgentOptions } from '../runtime/agent-spawn-types.js';
import type { ConversationRoute } from '../domain/types.js';
import {
  describeFailover,
  executionProviderIdForCandidate,
  shouldFailoverToNextCandidate,
  type FailoverAdvanceDetails,
} from '../runtime/failover-candidate-loop.js';

// Jobs-lane model-family failover around the agent spawn. Re-spawns the run on
// the NEXT configured candidate UNDER THE SAME lease (no re-claim, no new
// fencing version — that is reserved for stale-lease recovery) while NO visible
// output has streamed and the error is provider-specific. The streamed-output
// guard (`hasStreamedOutput`) is the load-bearing safety boundary: a provider
// failing after a streamed delta must not re-spawn. The loop is bounded to the
// candidate count, never infinite. `timeoutMs` is enforced per attempt by the
// runner (each spawn receives the same runOptions); the caller's lease heartbeat
// covers the wall-clock budget across attempts.
export async function runJobAgentWithFailover(input: {
  group: ConversationRoute;
  candidates: readonly string[];
  // The concrete model for the first attempt (already family-resolved); equals
  // candidates[0] when a candidate list exists. undefined lets spawn derive the
  // job default.
  firstModel: string | undefined;
  baseInput: Omit<AgentInput, 'model'>;
  spawn: typeof spawnAgent;
  onProcess: Parameters<typeof spawnAgent>[2];
  streamHandler: (output: AgentOutput) => Promise<void>;
  runOptions: RunAgentOptions;
  fallbackProviderId: ExecutionProviderId;
  agentHarness?: AgentHarness;
  hasStreamedOutput: () => boolean;
  // Called before each failover re-spawn so the caller can reconcile the run's
  // recorded provider metadata with the failover target, reset per-attempt error
  // state, and emit observability (RUN_FAILOVER). Returns the provider id the run
  // is moving FROM (for logging).
  onFailover: (
    toProviderId: ExecutionProviderId,
    details: FailoverAdvanceDetails,
  ) => Promise<ExecutionProviderId>;
  log: (message: string) => void;
}): Promise<AgentOutput> {
  const runAttempt = (model: string | undefined): Promise<AgentOutput> =>
    input.spawn(
      input.group,
      { ...input.baseInput, ...(model ? { model } : {}) } as AgentInput,
      input.onProcess,
      input.streamHandler,
      input.runOptions,
    );

  let output = await runAttempt(input.firstModel);
  const candidateCount = Math.max(1, input.candidates.length);
  for (
    let attempt = 0;
    shouldFailoverToNextCandidate({
      status: output.status,
      error: output.error,
      hasStreamedOutput: input.hasStreamedOutput(),
      attempt,
      candidateCount,
    });
    attempt += 1
  ) {
    const toModel = input.candidates[attempt + 1];
    if (!toModel) break;
    const toProviderId = executionProviderIdForCandidate(
      toModel,
      input.fallbackProviderId,
      input.agentHarness,
    );
    const fromModel =
      input.candidates[attempt] ?? input.firstModel ?? '(default)';
    const fromProviderId = await input.onFailover(toProviderId, {
      toProviderId,
      fromModel,
      toModel,
      reason: output.error,
    });
    input.log(
      describeFailover({
        fromProviderId,
        toProviderId,
        fromModel,
        toModel,
        reason: output.error,
      }),
    );
    output = await runAttempt(toModel);
  }
  return output;
}
