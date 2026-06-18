import type { AgentOutput } from './agent-spawn-types.js';

export function isVisibleResultFrame(output: AgentOutput): boolean {
  return typeof output.result === 'string' && output.result.length > 0;
}

export function isRunnerCompletionEvidenceFrame(output: AgentOutput): boolean {
  if (output.status !== 'success') return false;
  if (
    output.sessionInit ||
    output.runtimeEventOnly ||
    output.compactBoundary ||
    output.interactionBoundary
  ) {
    return false;
  }
  if (isVisibleResultFrame(output)) return true;
  if (output.result !== null) return false;
  if (output.usage || output.usageEventId || output.contextUsage) return true;
  return !output.runtimeEvents?.length;
}

export function isAgentTurnCompleteMarker(result: AgentOutput): boolean {
  return (
    result.status === 'success' &&
    !result.result &&
    !result.sessionInit &&
    !result.runtimeEventOnly &&
    !result.compactBoundary &&
    !result.interactionBoundary
  );
}

export function createSerializedAgentOutputCallbacks(args: {
  handle: (result: AgentOutput) => Promise<void>;
  onError: (err: unknown) => void;
}): {
  enqueue: (result: AgentOutput) => Promise<void>;
  wait: () => Promise<void>;
} {
  let chain = Promise.resolve();

  return {
    enqueue(result) {
      const next = chain.then(() => args.handle(result));
      chain = next.catch(args.onError);
      return next;
    },
    wait() {
      return chain;
    },
  };
}
