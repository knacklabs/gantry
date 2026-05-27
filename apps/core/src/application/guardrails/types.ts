import type { GuardrailConfig } from '../../domain/types.js';

export type GuardrailResponseKind =
  | 'greeting'
  | 'scope_rejection'
  | 'scope_clarification';

export type GuardrailDecision =
  | { action: 'allow'; reason: string }
  | {
      action: 'direct_response';
      responseKind: GuardrailResponseKind;
      reason: string;
    };

export interface GuardrailClassifierInput {
  policy: string;
  model: string;
  messages: readonly string[];
  prompt: string;
}

export type GuardrailClassifier = (
  input: GuardrailClassifierInput,
) => Promise<unknown> | unknown;

export interface EvaluateAgentGuardrailInput {
  config?: GuardrailConfig;
  messages: readonly string[];
  classifier?: GuardrailClassifier;
}

export interface GuardrailPolicy {
  id: string;
  prompt: string;
  evaluateDeterministic(messages: readonly string[]): GuardrailDecision | null;
  directResponse(kind: GuardrailResponseKind): string;
}
