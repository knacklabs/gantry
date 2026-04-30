export type StreamingOutputFinalizeReason =
  | 'success-marker'
  | 'error-marker'
  | 'turn-complete'
  | 'interaction-boundary';

export function createStreamingOutputState(args: {
  enabled: boolean;
  finalizeChunk: (reason: StreamingOutputFinalizeReason) => Promise<void>;
}): {
  markContent: () => void;
  finalize: (reason: StreamingOutputFinalizeReason) => Promise<void>;
  startNext: () => void;
} {
  let finalized = false;
  let hasContent = false;
  return {
    markContent() {
      hasContent = true;
    },
    async finalize(reason) {
      if (!args.enabled || finalized || !hasContent) return;
      finalized = true;
      await args.finalizeChunk(reason);
    },
    startNext() {
      finalized = false;
      hasContent = false;
    },
  };
}
