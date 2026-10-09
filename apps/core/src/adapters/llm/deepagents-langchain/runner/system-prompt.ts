import {
  buildGantryAgentSystemPrompt,
  type GantryAgentPromptMode,
} from '../../../../runner/gantry-agent-system-prompt.js';
import type { DeepAgentRunnerInput } from './types.js';
import { withMountedGantryToolNames } from '../../../../shared/gantry-mcp-tool-surface.js';
import { buildGantryMcpProjection } from './gantry-mcp-env.js';

// Composes the DeepAgents `systemPrompt` from the same provider-neutral
// AgentInput fields the Anthropic runner uses (compiled persona/system prompt +
// the durable-memory boundary policy when a memory context block is present),
// WITHOUT any Claude-specific prompt bundle. DeepAgents combines this with its
// own base agent prompt. The memory context block itself is injected as the
// leading user message (untrusted data), never as system authority.

export function composeDeepAgentSystemPrompt(
  input: DeepAgentRunnerInput,
  mountedGantryToolNames?: ReadonlySet<string>,
): string | undefined {
  const memoryBlock = readMemoryContextBlock(input);
  return buildGantryAgentSystemPrompt({
    runtimeProjection: 'wrapped-tool-projection',
    promptMode: input.promptMode as GantryAgentPromptMode | undefined,
    assistantName: input.assistantName,
    persona: input.persona,
    compiledSystemPrompt: mountedGantryToolNames
      ? withMountedGantryToolNames(
          input.compiledSystemPrompt,
          mountedGantryToolNames,
          input.allowedTools ?? [],
          buildGantryMcpProjection({
            configuredAllowedTools: input.allowedTools ?? [],
            hideAuthorityTools: input.hideAuthorityTools === true,
            processEnv: process.env,
          }).env,
          {
            RunCommand:
              process.env.GANTRY_DEEPAGENTS_SHELL_ENABLED === '1'
                ? 'RunCommand has not been granted'
                : 'shell execution is unavailable',
            FileSearch: 'filesystem tools are unavailable',
            FileRead: 'filesystem tools are unavailable',
            FileEdit: 'filesystem tools are unavailable',
            FileWrite: 'filesystem tools are unavailable',
          },
        )
      : input.compiledSystemPrompt,
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
