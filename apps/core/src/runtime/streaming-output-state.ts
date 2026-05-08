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
  finalize: (reason: StreamingOutputFinalizeReason) => Promise<boolean>;
  startNext: () => void;
} {
  let finalized = false;
  let hasContent = false;
  return {
    markContent() {
      hasContent = true;
    },
    async finalize(reason) {
      if (!args.enabled || finalized || !hasContent) return false;
      finalized = true;
      await args.finalizeChunk(reason);
      return true;
    },
    startNext() {
      finalized = false;
      hasContent = false;
    },
  };
}
