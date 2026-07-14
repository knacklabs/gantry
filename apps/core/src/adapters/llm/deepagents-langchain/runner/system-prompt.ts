import {
  buildGantryAgentSystemPrompt,
  type GantryAgentPromptMode,
} from '../../../../runner/gantry-agent-system-prompt.js';
import type { DeepAgentRunnerInput } from './types.js';

// Composes the DeepAgents `systemPrompt` from the same provider-neutral
// AgentInput fields the Anthropic runner uses (compiled persona/system prompt +
// the durable-memory boundary policy when a memory context block is present),
// WITHOUT any Claude-specific prompt bundle. DeepAgents combines this with its
// own base agent prompt. The memory context block itself is injected as the
// leading user message (untrusted data), never as system authority.

export function composeDeepAgentSystemPrompt(
  input: DeepAgentRunnerInput,
): string | undefined {
  const memoryBlock = readMemoryContextBlock(input);
  return buildGantryAgentSystemPrompt({
    runtimeProjection: 'wrapped-tool-projection',
    promptMode: input.promptMode as GantryAgentPromptMode | undefined,
    assistantName: input.assistantName,
    persona: input.persona,
    compiledSystemPrompt: input.compiledSystemPrompt,
    hasMemoryContext: Boolean(memoryBlock),
    selectedToolRules: input.allowedTools,
    workspaceFolder: input.workspaceFolder,
    conversationId: input.chatJid,
    threadId: input.threadId,
    isScheduledJob: input.isScheduledJob,
    currentDateTimeIso: new Date().toISOString(),
  }).prompt;
}

export function readMemoryContextBlock(input: DeepAgentRunnerInput): string {
  return typeof input.memoryContextBlock === 'string'
    ? input.memoryContextBlock.trim()
    : '';
}
