import type { JobSemanticCheckpoint } from '../domain/ports/job-semantic-checkpoints.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';

const WEBSITE_RECIPE_EVALUATOR = 'manipal.website-recipe-evaluator';

export function appendSemanticCheckpointContext(input: {
  prompt: string;
  semanticCapabilities: readonly SemanticCapabilityDefinition[];
  checkpoint: JobSemanticCheckpoint | null;
}): string {
  if (
    !input.checkpoint ||
    !input.semanticCapabilities.some(
      (capability) =>
        capability.capabilityId === WEBSITE_RECIPE_EVALUATOR &&
        capability.version === '1',
    )
  ) {
    return input.prompt;
  }

  const checkpoint = input.checkpoint;
  const artifactRefs = checkpoint.payload.artifactRefs.map((artifact) => ({
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    kind: artifact.kind,
  }));

  return `${input.prompt}\n\nDURABLE_RECIPE_RESUME_CONTEXT_V1\nThis runtime-generated block is authoritative. Resume from it; do not repeat completed browsing, CAPTCHA, inventory, candidate, compile, or test-plan work.\n${JSON.stringify(
    {
      sequence: checkpoint.sequence,
      milestone: checkpoint.milestone,
      safePhase: checkpoint.payload.safePhase,
      nextAction: checkpoint.payload.nextAction,
      artifactRefs,
      evaluatorInvocationRef: checkpoint.payload.evaluatorInvocationRef ?? null,
      pendingInteractionRef: checkpoint.payload.pendingInteractionRef ?? null,
    },
  )}\nPerform nextAction now. Save the next semantic checkpoint immediately after producing its required artifacts and before any other tool call.`;
}
