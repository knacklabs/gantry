import { composeSystemPromptAppend } from '../../../../runner/memory-boundary.js';
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
