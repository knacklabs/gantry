import type { GuardrailConfig } from '../../domain/types.js';

export type GuardrailResponseKind =
  | 'greeting'
  | 'scope_rejection'
  | 'scope_clarification';

export type GuardrailDecision =
  | { action: 'allow'; reason: string; systemPromptAppend?: string }
  | {
      action: 'direct_response';
      responseKind: GuardrailResponseKind;
      reason: string;
    };

/**
 * A prior turn of the conversation, role-tagged, supplied to the guardrail so a
 * policy can tell a genuine in-scope follow-up ("no it isn't", "are you sure?")
 * from an out-of-scope pivot. `messages` remains the NEW turn(s) being judged;
 * `context` is the recent history that precedes them (oldest→newest).
 */
export interface GuardrailContextMessage {
  role: 'customer' | 'assistant';
  text: string;
}

export interface GuardrailClassifierInput {
  policy: string;
  model: string;
  messages: readonly string[];
  prompt: string;
  context?: readonly GuardrailContextMessage[];
}

export type GuardrailClassifier = (
  input: GuardrailClassifierInput,
) => Promise<unknown> | unknown;

export interface EvaluateAgentGuardrailInput {
  config?: GuardrailConfig;
  messages: readonly string[];
  classifier?: GuardrailClassifier;
  /**
   * The resolved guardrail policy (agent plugin or generic fallback), supplied
   * by the caller which knows the agent folder. Absent → treated as an unknown
   * policy (fail closed with scope_rejection).
   */
  policy?: GuardrailPolicy;
  /**
   * Recent conversation turns preceding `messages` (oldest→newest), so the
   * policy can disambiguate context-dependent follow-ups. Optional — when
   * absent the policy behaves as a stateless per-turn screen.
   */
  context?: readonly GuardrailContextMessage[];
  /**
   * True only when the caller can attach the returned prompt to the next main
   * agent system prompt. Warm continuation paths cannot safely change the
   * existing provider session prompt, so they should leave this false.
   */
  allowInlineSystemPromptAppend?: boolean;
}

export interface GuardrailPolicy {
  id: string;
  prompt: string;
  /**
   * Optional cheap, deterministic pre-agent screen. Omit it for a
   * classifier-only policy that screens every message with the LLM (no
   * deterministic fast-path).
   * `context` (recent prior turns) is optional so policies that ignore it remain
   * valid; context-aware policies may use it to allow genuine follow-ups without
   * an LLM call.
   */
  evaluateDeterministic?(
    messages: readonly string[],
    context?: readonly GuardrailContextMessage[],
  ): GuardrailDecision | null;
  /**
   * Optional run-local system prompt append for policies that want the main
   * agent call to carry the final scope check. When present, `mode: both`
   * uses deterministic screening plus direct agent fallthrough instead of a
   * separate classifier call.
   */
  systemPromptAppend?(
    messages: readonly string[],
    context?: readonly GuardrailContextMessage[],
  ): string | null;
  directResponse(kind: GuardrailResponseKind): string;
}
