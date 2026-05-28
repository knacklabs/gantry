import { composeSystemPromptAppend } from '../../../../runner/memory-boundary.js';
import {
  resolveAgentPersona,
  type AgentPersona,
} from '../../../../shared/agent-persona.js';
import { log } from './logging.js';
import type { AgentRunnerInput } from './types.js';

export interface RunnerSystemPromptContext {
  approvedMcpServerNames?: readonly string[];
}

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
  context: RunnerSystemPromptContext = {},
): ReturnType<typeof buildSystemPrompt> {
  return buildSystemPrompt(
    composeSystemPromptAppend(
      [agentInput.compiledSystemPrompt, approvedMcpServicesPrompt(context)]
        .filter(Boolean)
        .join('\n\n'),
      Boolean(memoryBlock),
    ),
  );
}

function approvedMcpServicesPrompt(context: RunnerSystemPromptContext): string {
  const names = [
    ...new Set(
      (context.approvedMcpServerNames ?? []).map((name) => name.trim()),
    ),
  ]
    .filter(Boolean)
    .sort();
  if (names.length === 0) return '';
  const lines = [
    '## Approved MCP Services',
    `Approved third-party MCP services for this run: ${names.join(', ')}.`,
    'When the user asks for customer, order, product, account, or store data that may live in an approved MCP service, call mcp_list_tools first and then mcp_call_tool with the matching serverName before saying you do not have access.',
    'Do not invent a separate verification policy before the call; approved MCP tools enforce their own access and identity checks. If the tool denies access, returns not found, or errors, explain that result briefly.',
    'Use only the information returned by the MCP tool in your answer.',
  ];
  return lines.join('\n');
}

export function includeGitInstructionsForPersona(
  persona: AgentPersona | undefined,
): boolean {
  return resolveAgentPersona(persona) === 'developer';
}
