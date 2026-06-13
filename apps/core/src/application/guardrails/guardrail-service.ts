import type {
  EvaluateAgentGuardrailInput,
  GuardrailDecision,
  GuardrailPolicy,
  GuardrailResponseKind,
} from './types.js';

export async function evaluateAgentGuardrail(
  input: EvaluateAgentGuardrailInput,
): Promise<GuardrailDecision> {
  const config = input.config;
  if (!config) return { action: 'allow', reason: 'no_guardrail' };
  const policy = input.policy;
  if (!policy) {
    return {
      action: 'direct_response',
      responseKind: 'scope_rejection',
      reason: 'unknown_policy',
    };
  }
  const mode = config.mode ?? 'both';
  // The parser guarantees a valid (mode, unresolved) pairing; default both →
  // classifier preserves exact legacy behavior when neither field is set.
  const unresolved = config.unresolved ?? 'classifier';
  const inlineAllowed = input.allowInlineSystemPromptAppend !== false;

  // Compute the policy's inline scope block on demand. It is consulted ONLY
  // when `unresolved: inline` (and the inline path is attachable) — never
  // inferred from whether the policy happens to export this function.
  const append = (): string | null =>
    policy.systemPromptAppend?.(input.messages, input.context)?.trim() || null;

  // The classifier path is unchanged; only the branching around it changed.
  // Arrow function (not a hoisted declaration) so it captures the narrowed
  // `policy`/`config` consts above.
  const runClassifier = async (): Promise<GuardrailDecision> => {
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
        model: config.model,
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
  };

  if (mode === 'classifier') {
    // Classifier runs every turn; there is no deterministic stage.
    return runClassifier();
  }

  // mode === 'deterministic' || mode === 'both'
  const deterministic =
    policy.evaluateDeterministic?.(input.messages, input.context) ?? null;
  if (deterministic) {
    if (deterministic.action === 'allow' && unresolved === 'inline') {
      const a = inlineAllowed ? append() : null;
      if (a) return { ...deterministic, systemPromptAppend: a };
    }
    return deterministic;
  }

  switch (unresolved) {
    case 'classifier':
      // mode === 'both' (the parser rejects classifier for deterministic).
      return runClassifier();
    case 'inline': {
      if (!inlineAllowed) {
        // Warm continuation cannot safely change the live session prompt;
        // allow plain rather than silently escalating to the classifier.
        return {
          action: 'allow',
          reason: 'inconclusive_inline_guardrail_unattached',
        };
      }
      const a = append();
      return a
        ? {
            action: 'allow',
            reason: 'inconclusive_inline_guardrail',
            systemPromptAppend: a,
          }
        : {
            action: 'direct_response',
            responseKind: 'scope_clarification',
            reason: 'inline_guardrail_unconfigured',
          };
    }
    case 'allow':
      return { action: 'allow', reason: 'unresolved_allow' };
    case 'reject':
      return {
        action: 'direct_response',
        responseKind: 'scope_rejection',
        reason: 'unresolved_reject',
      };
    case 'clarify':
      return {
        action: 'direct_response',
        responseKind: 'scope_clarification',
        reason: 'unresolved_clarify',
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
