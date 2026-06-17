import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';

import { composeSystemPromptAppend } from '../../../../runner/memory-boundary.js';
import {
  buildGantryAgentSystemPrompt,
  type GantryAgentPromptMode,
} from '../../../../runner/gantry-agent-system-prompt.js';
import {
  resolveAgentPersona,
  type AgentPersona,
} from '../../../../shared/agent-persona.js';
import { log } from './logging.js';
import type { AgentRunnerInput } from './types.js';

export function buildSystemPrompt(append?: string):
  | {
      type: 'preset';
      preset: 'claude_code';
      append: string;
      excludeDynamicSections: boolean;
    }
  | string[]
  | undefined {
  const trimmed = append?.trim();
  if (!trimmed) return undefined;
  return {
    type: 'preset',
    preset: 'claude_code',
    append: trimmed,
    // Strip per-user dynamic sections (cwd, auto-memory path, git status)
    // from the cached system prompt prefix. They are re-injected as the first
    // user message so the model still sees them.
    excludeDynamicSections: true,
  };
}

export function readMemoryContextBlock(agentInput: AgentRunnerInput): string {
  try {
    return typeof agentInput.memoryContextBlock === 'string'
      ? agentInput.memoryContextBlock.trim()
      : '';
  } catch (err) {
    log(
      `Failed to load memory context block: ${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

export function buildRunnerSystemPrompt(
  agentInput: AgentRunnerInput,
  memoryBlock: string,
): ReturnType<typeof buildSystemPrompt> {
  if (!includeGitInstructionsForPersona(agentInput.persona)) {
    const prompt = buildGantryAgentSystemPrompt({
      runtimeProjection: 'native-tool-projection',
      promptMode: agentInput.promptMode as GantryAgentPromptMode | undefined,
      assistantName: agentInput.assistantName,
      persona: agentInput.persona,
      compiledSystemPrompt: agentInput.compiledSystemPrompt,
      hasMemoryContext: Boolean(memoryBlock),
      selectedToolRules: agentInput.allowedTools,
      workspaceFolder: agentInput.workspaceFolder,
      conversationId: agentInput.chatJid,
      threadId: agentInput.threadId,
      isScheduledJob: agentInput.isScheduledJob,
      currentDateTimeIso: new Date().toISOString(),
    });
    return prompt.dynamicPrompt
      ? [
          prompt.staticPrompt,
          SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
          prompt.dynamicPrompt,
        ]
      : [prompt.staticPrompt];
  }
  return buildSystemPrompt(
    composeSystemPromptAppend(
      agentInput.compiledSystemPrompt,
      Boolean(memoryBlock),
    ),
  );
}

export function includeGitInstructionsForPersona(
  persona: AgentPersona | undefined,
): boolean {
  return resolveAgentPersona(persona) === 'developer';
}
