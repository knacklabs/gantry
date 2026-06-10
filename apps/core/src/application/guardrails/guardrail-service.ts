import type {
  EvaluateAgentGuardrailInput,
  GuardrailDecision,
  GuardrailPolicy,
  GuardrailResponseKind,
} from './types.js';

export async function evaluateAgentGuardrail(
  input: EvaluateAgentGuardrailInput,
): Promise<GuardrailDecision> {
  if (!input.config) return { action: 'allow', reason: 'no_guardrail' };
  const policy = input.policy;
  if (!policy) {
    return {
      action: 'direct_response',
      responseKind: 'scope_rejection',
      reason: 'unknown_policy',
    };
  }
  const mode = input.config.mode ?? 'both';
  if (mode === 'both' || mode === 'deterministic') {
    // Classifier-only policies omit evaluateDeterministic; treat an absent
    // deterministic stage as "no decision" so screening defers to the
    // classifier below.
    const deterministic =
      policy.evaluateDeterministic?.(input.messages, input.context) ?? null;
    if (deterministic) return deterministic;
    if (mode === 'deterministic') {
      return {
        action: 'direct_response',
        responseKind: 'scope_clarification',
        reason: 'ambiguous_without_classifier',
      };
    }
  }
  if (!input.classifier) {
    // No classifier to disambiguate: ask the customer to clarify rather than
    // hard-rejecting. A bare scope_rejection here turns away real (often
    // non-English) support messages that simply missed the keyword fast-path.
    return {
      action: 'direct_response',
      responseKind: 'scope_clarification',
      reason: 'ambiguous_without_classifier',
    };
  }
  try {
    const decision = await input.classifier({
      policy: policy.id,
      model: input.config.model,
      messages: input.messages,
      prompt: policy.prompt,
      context: input.context,
    });
    return parseClassifierDecision(decision);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Guardrails fail closed on any classifier/provider error.
  } catch {
    return {
      action: 'direct_response',
      responseKind: 'scope_rejection',
      reason: 'classifier_failed',
    };
  }
}

export function customerVisibleGuardrailResponse(
  policy: GuardrailPolicy | undefined,
  kind: GuardrailResponseKind,
): string {
  return (
    policy?.directResponse(kind) ??
    'I can only help with the configured support scope.'
  );
}

function parseClassifierDecision(raw: unknown): GuardrailDecision {
  if (!isRecord(raw)) {
    return invalidClassifierDecision();
  }
  if (raw.action === 'allow' && typeof raw.reason === 'string') {
    return { action: 'allow', reason: raw.reason };
  }
  if (
    raw.action === 'direct_response' &&
    isGuardrailResponseKind(raw.responseKind) &&
    typeof raw.reason === 'string'
  ) {
    return {
      action: 'direct_response',
      responseKind: raw.responseKind,
      reason: raw.reason,
    };
  }
  return invalidClassifierDecision();
}

function invalidClassifierDecision(): GuardrailDecision {
  return {
    action: 'direct_response',
    responseKind: 'scope_rejection',
    reason: 'invalid_classifier_output',
  };
}

function isGuardrailResponseKind(
  value: unknown,
): value is GuardrailResponseKind {
  return (
    value === 'greeting' ||
    value === 'scope_rejection' ||
    value === 'scope_clarification'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
