import type { JobSemanticCheckpoint } from '../domain/ports/job-semantic-checkpoints.js';
import type { PublicAsyncTaskDto } from '../domain/ports/async-tasks.js';

export function appendSemanticCheckpointContext(input: {
  prompt: string;
  checkpoint: JobSemanticCheckpoint | null;
  completedExternalTasks?: PublicAsyncTaskDto[];
}): string {
  if (!input.checkpoint && !input.completedExternalTasks?.length) {
    return input.prompt;
  }

  const checkpoint = input.checkpoint
    ? {
        sequence: input.checkpoint.sequence,
        milestone: input.checkpoint.milestone,
        safePhase: input.checkpoint.payload.safePhase,
        nextAction: input.checkpoint.payload.nextAction,
        artifactRefs: input.checkpoint.payload.artifactRefs.map((artifact) => ({
          artifactId: artifact.artifactId,
          contentHash: artifact.contentHash,
          kind: artifact.kind,
        })),
        evaluatorInvocationRef:
          input.checkpoint.payload.evaluatorInvocationRef ?? null,
        pendingInteractionRef:
          input.checkpoint.payload.pendingInteractionRef ?? null,
      }
    : null;
  const completedExternalTasks = (input.completedExternalTasks ?? []).map(
    (task) => ({
      id: task.id,
      status: task.status,
      summary: task.summary ?? null,
      outputSummary: task.outputSummary ?? null,
      errorSummary: task.errorSummary ?? null,
      resultRef: task.resultRef ?? null,
      result: task.result ?? null,
      receiptLines: task.receiptLines,
      terminalAt: task.terminalAt ?? null,
    }),
  );

  return `${input.prompt}\n\nDURABLE_JOB_RESUME_CONTEXT_V1
This runtime-generated block is authoritative. Resume from it and do not repeat completed work represented by immutable artifact references or completed external tasks.
${JSON.stringify({ checkpoint, completedExternalTasks })}
Inspect every completed external task result before performing checkpoint.nextAction. A failed result requires changed inputs, a supported terminal conclusion, or other concrete progress; do not resubmit an unchanged invocation. Save the next semantic checkpoint at the next durable semantic boundary.`;
}
