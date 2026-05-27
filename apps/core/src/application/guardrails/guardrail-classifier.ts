import type {
  GuardrailClassifier,
  GuardrailClassifierInput,
} from './types.js';
import { resolveModelSelection } from '../../shared/model-catalog.js';

export type GuardrailLlmQuery = (input: {
  model: string;
  systemPrompt: string;
  prompt: string;
  disableTools: boolean;
}) => Promise<string>;

export const createGuardrailClassifier = (options: {
  query: GuardrailLlmQuery;
}): GuardrailClassifier => {
  return async (input: GuardrailClassifierInput): Promise<unknown> => {
    const resolved = resolveModelSelection(input.model);
    if (!resolved.ok) {
      throw new Error(`Invalid guardrail classifier model: ${resolved.message}`);
    }
    const text = await options.query({
      model: resolved.runnerModel,
      systemPrompt: input.prompt,
      disableTools: true,
      prompt: JSON.stringify(
        {
          policy: input.policy,
          messages: input.messages,
        },
        null,
        2,
      ),
    });
    return parseJsonObject(text);
  };
};

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]);
    } catch (nestedErr) {
      if (!(nestedErr instanceof SyntaxError)) throw nestedErr;
      return undefined;
    }
  }
}
