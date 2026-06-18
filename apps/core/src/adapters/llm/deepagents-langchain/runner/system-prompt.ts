import { composeSystemPromptAppend } from '../../../../runner/memory-boundary.js';
import type { DeepAgentRunnerInput } from './types.js';

// Composes the DeepAgents `systemPrompt` from the same provider-neutral
// AgentInput fields the Anthropic runner uses (compiled persona/system prompt +
// the durable-memory boundary policy when a memory context block is present),
// WITHOUT any Claude preset. DeepAgents combines this with its own base agent
// prompt. The memory context block itself is injected as the leading user
// message (untrusted data), never as system authority.

export function composeDeepAgentSystemPrompt(
  input: DeepAgentRunnerInput,
): string | undefined {
  const memoryBlock = readMemoryContextBlock(input);
  return composeSystemPromptAppend(
    input.compiledSystemPrompt,
    Boolean(memoryBlock),
  );
}

export function readMemoryContextBlock(input: DeepAgentRunnerInput): string {
  return typeof input.memoryContextBlock === 'string'
    ? input.memoryContextBlock.trim()
    : '';
}
