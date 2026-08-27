import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function modelVisibleExternalCapabilityResult(
  message: string | undefined,
  data: unknown,
): CallToolResult {
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    ['completed', 'compiled'].includes(
      String((data as Record<string, unknown>).status),
    )
  ) {
    const structuredContent = data as Record<string, unknown>;
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    };
  }
  return {
    content: [
      {
        type: 'text',
        text:
          message || 'External capability accepted; this job is suspending.',
      },
    ],
  };
}

export function formatWebsiteRecipeEvaluatorRejection(error: string): string {
  if (error.includes('UNCHANGED_FAILED_EVALUATION')) {
    return [
      'Evaluator submission was rejected before execution.',
      error,
      'This exact candidate, binding, coverage manifest, and test plan already failed deterministic evaluation. Do not submit them again.',
      'Either make a material repair that changes the compiled recipe or compiler-bound test plan, or save milestone="needs_review" with safePhase="needs_review_proof_incomplete" and explain the missing coverage, retained evidence, activation risk, and recommended administrator action.',
    ].join('\n');
  }
  return [
    'Evaluator submission was rejected before execution.',
    error,
    'Treat this as a repair observation: correct the retained candidate, inventory, test plan, or submission arguments, save a new semantic checkpoint, and submit again.',
  ].join('\n');
}
