import { composeSystemPromptAppend } from '../../../../runner/memory-boundary.js';
import {
  resolveAgentPersona,
  type AgentPersona,
} from '../../../../shared/agent-persona.js';
import { log } from './logging.js';
import type { AgentRunnerInput } from './types.js';

export interface RunnerSystemPromptContext {
  approvedMcpServerNames?: readonly string[];
  mcpListToolsEnabled?: boolean;
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

export interface BuildRunnerSystemPromptOptions {
  /**
   * Warm-pool generic boot (Pillar 2 Fix #2): OMIT the per-customer guardrail
   * append from the cached boot prefix. It rides the first user message
   * per-turn instead, so the shared prefix is byte-identical across customers
   * (the cache anchor). Default false ⇒ cold path keeps the guardrail in boot.
   */
  genericBoot?: boolean;
}

export function buildRunnerSystemPrompt(
  agentInput: AgentRunnerInput,
  memoryBlock: string,
  context: RunnerSystemPromptContext = {},
  options: BuildRunnerSystemPromptOptions = {},
): ReturnType<typeof buildSystemPrompt> {
  const isCustomerLive = agentInput.promptSurface === 'customer_live';
  return buildSystemPrompt(
    composeSystemPromptAppend(
      [
        agentInput.compiledSystemPrompt,
        // Generic boot moves the guardrail to a per-turn preface (Fix #2).
        options.genericBoot ? '' : agentInput.guardrailSystemPromptAppend,
        approvedMcpServicesPrompt(context),
      ]
        .filter(Boolean)
        .join('\n\n'),
      Boolean(memoryBlock),
      // Generic boot forces the boundary policy into the shared prefix so it is
      // byte-identical across customers (Fix #1). The cold path keeps the policy
      // gated on memory presence ⇒ pool-off prompt stays byte-for-byte as today.
      {
        forceBoundaryPolicy: options.genericBoot ?? false,
        boundaryStyle: isCustomerLive ? 'compact' : 'full',
      },
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
    context.mcpListToolsEnabled
      ? 'When the user asks for customer, order, product, account, or store data that may live in an approved MCP service: if current instructions already name the serverName and tool name, call mcp_call_tool directly; use mcp_list_tools directly only when you do not know which approved tool to call. Never route mcp_list_tools through mcp_call_tool.'
      : 'When the user asks for customer, order, product, account, or store data that may live in an approved MCP service: if current instructions already name the serverName and tool name, call mcp_call_tool directly. mcp_list_tools is not enabled for this run; never route mcp_list_tools through mcp_call_tool. If no known source route fits, say the team/source can confirm.',
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
