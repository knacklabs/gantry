type ActiveRun = {
  abort(reason: string): void;
};

const activeRuns = new Map<string, ActiveRun>();

function key(jobId: string, runId: string) {
  return `${jobId}\0${runId}`;
}

export function registerExternalCapabilitySuspension(input: {
  jobId: string;
  runId: string;
  abort(reason: string): void;
}): () => void {
  const runKey = key(input.jobId, input.runId);
  activeRuns.set(runKey, input);
  return () => {
    if (activeRuns.get(runKey) === input) activeRuns.delete(runKey);
  };
}

export function suspendForExternalCapability(input: {
  jobId: string;
  runId: string;
  taskId: string;
}): boolean {
  const run = activeRuns.get(key(input.jobId, input.runId));
  if (!run) return false;
  run.abort(`Waiting for external capability task ${input.taskId}.`);
  return true;
}
