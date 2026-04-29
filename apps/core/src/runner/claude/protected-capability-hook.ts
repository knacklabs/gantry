import path from 'node:path';
import type {
  HookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';

const BLOCK_MESSAGE =
  'MyClaw blocks direct edits to agent capability configuration. Use mcp__myclaw__request_skill_draft or mcp__myclaw__request_mcp_server so the change is reviewed, stored durably, and activated on a later run.';

export interface ProtectedCapabilityDecision {
  reason: string;
}

export function evaluateProtectedCapabilityToolUse(
  toolName: string,
  input: unknown,
): ProtectedCapabilityDecision | null {
  if (
    toolName === 'mcp__myclaw__request_mcp_server' ||
    toolName === 'mcp__myclaw__request_skill_draft'
  ) {
    return null;
  }

  if (toolName === 'Config') {
    return evaluateConfigInput(input);
  }

  if (toolName === 'Bash') {
    return evaluateBashInput(input);
  }

  if (isFileMutationTool(toolName)) {
    return evaluateFileMutationInput(input);
  }

  return null;
}

export async function protectedCapabilityPreToolUseHook(
  input: HookInput,
): Promise<SyncHookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') {
    return { continue: true };
  }

  const decision = evaluateProtectedCapabilityToolUse(
    input.tool_name,
    input.tool_input,
  );
  if (!decision) {
    return { continue: true };
  }

  const reason = `${decision.reason} ${BLOCK_MESSAGE}`;
  return {
    continue: false,
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function evaluateConfigInput(
  input: unknown,
): ProtectedCapabilityDecision | null {
  const setting = stringField(input, 'setting');
  if (!setting) return null;

  if (
    /(^|\.)mcpServers($|\.)|(^|\.)permissions($|\.)|permissionMode/i.test(
      setting,
    )
  ) {
    return {
      reason: `Config setting "${setting}" changes capability or permission policy.`,
    };
  }
  return null;
}

function evaluateBashInput(input: unknown): ProtectedCapabilityDecision | null {
  const command = stringField(input, 'command') || stringField(input, 'cmd');
  if (!command) return null;

  if (
    /\bclaude\s+mcp\s+(add|add-json|remove|reset-project-choices)\b/i.test(
      command,
    )
  ) {
    return {
      reason: 'Shell command attempts to change Claude MCP configuration.',
    };
  }

  if (/\bmcpServers\b|\.mcp\.json\b/i.test(command)) {
    return {
      reason: 'Shell command references MCP capability configuration.',
    };
  }

  if (
    /(^|[\/\s])SKILL\.md\b|(^|[\/\s])\.claude\/skills\/|\bagents\/[^/\s]+\/skills\//i.test(
      command,
    )
  ) {
    return {
      reason: 'Shell command references skill capability files.',
    };
  }

  return null;
}

function evaluateFileMutationInput(
  input: unknown,
): ProtectedCapabilityDecision | null {
  const filePath =
    stringField(input, 'file_path') || stringField(input, 'notebook_path');
  if (!filePath) return null;

  const normalized = normalizePathForPolicy(filePath);
  if (isSkillCapabilityPath(normalized)) {
    return {
      reason: `File path "${filePath}" is a skill capability path.`,
    };
  }

  if (isMcpCapabilityPath(normalized)) {
    return {
      reason: `File path "${filePath}" is an MCP capability configuration path.`,
    };
  }

  if (
    isClaudeSettingsPath(normalized) &&
    mutationText(input).some((text) =>
      /\bmcpServers\b|permissionMode|permissions\./i.test(text),
    )
  ) {
    return {
      reason: `File path "${filePath}" changes Claude capability or permission settings.`,
    };
  }

  return null;
}

const FILE_MUTATION_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

function isFileMutationTool(toolName: string): boolean {
  return FILE_MUTATION_TOOLS.has(toolName);
}

function isSkillCapabilityPath(normalizedPath: string): boolean {
  return (
    normalizedPath.endsWith('/SKILL.md') ||
    normalizedPath.includes('/.claude/skills/') ||
    /\/agents\/[^/]+\/skills\//.test(normalizedPath)
  );
}

function isMcpCapabilityPath(normalizedPath: string): boolean {
  return (
    normalizedPath.endsWith('/.mcp.json') ||
    normalizedPath.endsWith('/mcp.json') ||
    normalizedPath.includes('/.claude/mcp/')
  );
}

function isClaudeSettingsPath(normalizedPath: string): boolean {
  return (
    normalizedPath.endsWith('/settings.json') ||
    normalizedPath.endsWith('/settings.local.json')
  );
}

function mutationText(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  const values = ['content', 'new_string', 'old_string', 'new_source']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string');
  const edits = record.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      for (const value of Object.values(edit)) {
        if (typeof value === 'string') values.push(value);
      }
    }
  }
  return values;
}

function stringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizePathForPolicy(filePath: string): string {
  return `/${path
    .normalize(filePath)
    .replaceAll(path.sep, '/')
    .replace(/^\/+/, '')}`;
}
