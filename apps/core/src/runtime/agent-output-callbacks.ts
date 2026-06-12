import type { AgentOutput } from './agent-spawn.js';

export function isAgentTurnCompleteMarker(result: AgentOutput): boolean {
  return (
    result.status === 'success' &&
    !result.result &&
    !result.sessionInit &&
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
