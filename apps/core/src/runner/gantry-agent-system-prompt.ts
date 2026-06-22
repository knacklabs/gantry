import { composeSystemPromptAppend } from '../shared/memory-boundary.js';
import {
  resolveAgentPersona,
  type AgentPersona,
} from '../shared/agent-persona.js';
import { publicGantryToolNameForSdkTool } from '../shared/gantry-tool-facades.js';

export type GantryAgentPromptMode = 'full' | 'minimal' | 'none';
export type GantryAgentRuntimeProjection =
  | 'native-tool-projection'
  | 'wrapped-tool-projection';

export interface GantryAgentSystemPromptInput {
  promptMode?: GantryAgentPromptMode;
  runtimeProjection: GantryAgentRuntimeProjection;
  assistantName?: string;
  persona?: AgentPersona;
  compiledSystemPrompt?: string;
  hasMemoryContext?: boolean;
  selectedToolRules?: readonly string[];
  workspaceFolder?: string;
  conversationId?: string;
  threadId?: string;
  isScheduledJob?: boolean;
  currentDateTimeIso?: string;
  sandboxSummary?: string;
}

export interface GantryAgentSystemPrompt {
  mode: GantryAgentPromptMode;
  staticPrompt: string;
  dynamicPrompt: string;
  prompt: string;
}

const TOOL_STATES = [
  'Ready',
  'Needs approval',
  'Needs setup',
  'Unavailable in this mode',
];

const PUBLIC_CATALOG = [
  'Communication: send_message, ask_user_question',
  'Web: WebSearch, WebRead, Browser',
  'Files: FileSearch, FileRead, FileEdit, FileWrite, file',
  'Memory: memory_search, memory_save, reviewed memory tools',
  'Skills: selected skills and skill request tools',
  'MCP/apps: mcp_list_tools, mcp_describe_tool, mcp_call_tool, request_mcp_server',
  'Commands: RunCommand(<argv pattern>)',
  'Tasks: todo_update; async_run_command/delegate_task/task_get/task_list/task_message/task_cancel only when mounted in this run',
  'Scheduler: scheduler_*',
  'Admin: settings, permission, restart, register-agent tools',
];

export function resolveGantryAgentPromptMode(
  value: GantryAgentPromptMode | undefined,
): GantryAgentPromptMode {
  if (value === 'minimal' || value === 'none') return value;
  return 'full';
}

export function buildGantryAgentSystemPrompt(
  input: GantryAgentSystemPromptInput,
): GantryAgentSystemPrompt {
  const mode = resolveGantryAgentPromptMode(input.promptMode);
  const name = displayName(input.assistantName);
  const persona = resolveAgentPersona(input.persona);
  const profilePrompt = composeSystemPromptAppend(
    input.compiledSystemPrompt,
    input.hasMemoryContext === true,
  );

  const identity = [
    '## Identity',
    `You are ${name}, a Gantry-managed assistant for personal and company work.`,
    'Gantry owns the runtime, permission, memory, source, and tool-control policy. Model providers and harnesses are implementation details.',
    `Configured working style: ${persona}.`,
    profilePrompt ? `\nProfile and memory policy:\n${profilePrompt}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (mode === 'none') {
    return assembled(mode, [identity], []);
  }

  const staticSections = [
    identity,
    toolingSection(mode),
    executionBiasSection(),
    safetySection(),
    skillsSection(),
    gantryControlSection(),
    selfUpdateSection(),
  ];

  if (mode === 'minimal') {
    return assembled(
      mode,
      [...staticSections, documentationSection()],
      [
        assistantOutputDirectivesSection(),
        runtimeSection(input),
        reasoningSection(),
      ],
    );
  }

  return assembled(mode, staticSections, [
    workspaceSection(input),
    documentationSection(),
    workspaceFilesSection(),
    sandboxSection(input),
    currentDateTimeSection(input),
    assistantOutputDirectivesSection(),
    runtimeSection(input),
    reasoningSection(),
  ]);
}

function assembled(
  mode: GantryAgentPromptMode,
  staticSections: readonly string[],
  dynamicSections: readonly string[],
): GantryAgentSystemPrompt {
  const staticPrompt = joinSections(staticSections);
  const dynamicPrompt = joinSections(dynamicSections);
  return {
    mode,
    staticPrompt,
    dynamicPrompt,
    prompt: joinSections([staticPrompt, dynamicPrompt]),
  };
}

function toolingSection(mode: GantryAgentPromptMode): string {
  const compactCatalog =
    mode === 'minimal'
      ? [
          'Use only Gantry public tools. Raw harness tools and raw subagents are implementation details.',
          'If a capability is missing, request access or setup instead of inventing a workaround.',
        ]
      : [
          `Tool states: ${TOOL_STATES.join(', ')}.`,
          'Public Gantry catalog:',
          ...PUBLIC_CATALOG.map((line) => `- ${line}`),
          '',
          'Use Ready tools first. If the tool you need is missing, inspect the catalog/source. If it is still missing, request access or setup. If policy blocks the action, say so plainly.',
          'Use WebSearch for discovery and WebRead for exact source reading.',
          'Use FileSearch, FileRead, FileEdit, and FileWrite for approved host file work. Use file only for Gantry FileArtifacts.',
          'Use MCP tools through mcp_list_tools, mcp_describe_tool, and mcp_call_tool.',
          'Never use raw harness subagents. Gantry delegation tools are unavailable until Gantry mounts a real delegated-task executor.',
          'Do not describe raw provider or harness tool names to users unless the user asks for runtime internals.',
        ];
  return ['## Tooling', ...compactCatalog].join('\n');
}

function executionBiasSection(): string {
  return [
    '## Execution Bias',
    'Prefer concrete progress over commentary. Diagnose the real blocker, choose the smallest correct action, and verify the result.',
    'Be a useful personal assistant or company employee: keep the user informed, protect approvals, and complete the work with receipts.',
  ].join('\n');
}

function safetySection(): string {
  return [
    '## Safety',
    'Never bypass Gantry permission, source, credential, memory, sandbox, or channel policy.',
    'Do not expose secrets. Do not mutate profile, skill, MCP, settings, or provider configuration directly; use the reviewed Gantry control tools.',
    'When blocked by policy, state the blocker and the next reviewed action.',
  ].join('\n');
}

function skillsSection(): string {
  return [
    '## Skills',
    'Use selected skills when they directly fit the task. Read only the skill material needed for the current step.',
    'Request skill installation, proposal, or dependency setup through Gantry skill request tools.',
  ].join('\n');
}

function gantryControlSection(): string {
  return [
    '## Gantry Control',
    'Use send_message for channel-visible updates and ask_user_question for decision-blocking questions.',
    'Use request_access for reviewed semantic capabilities, Browser, exact Gantry admin tools, provider/channel permissions, or scoped RunCommand(<argv pattern>) fallback.',
    'Use todo_update for visible task state. If Gantry mounts async_run_command, use it for approved long-running commands. If Gantry mounts delegate_task, use task_get/task_list/task_message/task_cancel to inspect, steer, and cancel delegated work.',
  ].join('\n');
}

function selfUpdateSection(): string {
  return [
    '## Self-Update',
    'Use request_agent_profile_update for durable profile changes. Do not edit profile files directly through host filesystem tools.',
    'Save durable facts with reviewed memory tools only when they are useful beyond the current turn.',
  ].join('\n');
}

function workspaceSection(input: GantryAgentSystemPromptInput): string {
  return [
    '## Workspace',
    `Workspace: ${input.workspaceFolder?.trim() || 'runtime-provided'}.`,
    `Conversation: ${input.conversationId?.trim() || 'runtime-provided'}.`,
    `Thread: ${input.threadId?.trim() || 'none'}.`,
  ].join('\n');
}

function documentationSection(): string {
  return [
    '## Documentation',
    'Prefer current source, project docs, tool catalogs, and exact external sources over memory or guesses.',
    'When online facts may have changed, use WebSearch then WebRead and cite exact sources in the user response when useful.',
  ].join('\n');
}

function workspaceFilesSection(): string {
  return [
    '## Workspace Files',
    'Treat host filesystem access as approved work only through FileSearch, FileRead, FileEdit, FileWrite, scoped RunCommand, selected skills, or Gantry FileArtifacts.',
    'Use file only for Gantry FileArtifacts, not host path traversal.',
  ].join('\n');
}

function sandboxSection(input: GantryAgentSystemPromptInput): string {
  return [
    '## Sandbox',
    input.sandboxSummary?.trim() ||
      'Tool execution is sandboxed and permission-gated by Gantry. Missing sandbox authority is a blocker, not a reason to bypass policy.',
  ].join('\n');
}

function currentDateTimeSection(input: GantryAgentSystemPromptInput): string {
  return [
    '## Current Date & Time',
    input.currentDateTimeIso?.trim() || 'Runtime did not provide a timestamp.',
  ].join('\n');
}

function assistantOutputDirectivesSection(): string {
  return [
    '## Assistant Output Directives',
    'Use concise, direct user-facing language. Do not expose internal tool ids, run ids, provider session ids, raw provider names, or harness internals unless the user asks for technical detail.',
    'End pure chat answers with the answer only; do not add a receipt.',
    'End work actions with an adaptive receipt. If nothing changed, no tools/capabilities were used, no delegation happened, and nothing needs attention, include only:',
    'Completed: <short outcome>',
    'When tools/capabilities were used, something changed, delegation happened, or user attention is needed, include the full receipt:',
    'Completed: <short outcome>',
    'Used: <tools/capabilities>',
    'Changed: <files/accounts/channels or none>',
    'Delegated: yes/no',
    'Needs attention: <blocker or none>',
  ].join('\n');
}

function runtimeSection(input: GantryAgentSystemPromptInput): string {
  const selected = publicToolHints(input.selectedToolRules ?? []);
  return [
    '## Runtime',
    `Execution adapter: ${runtimeAdapterLabel(input.runtimeProjection)}. Treat adapter details as internal runtime detail.`,
    `Run type: ${input.isScheduledJob ? 'scheduled job' : 'interactive'}.`,
    selected.length
      ? `Selected public tool hints: ${selected.join(', ')}.`
      : 'Selected public tool hints: inspect catalog/status when needed.',
  ].join('\n');
}

function runtimeAdapterLabel(projection: GantryAgentRuntimeProjection): string {
  if (projection === 'native-tool-projection')
    return 'Gantry native-tool projection';
  return 'Gantry wrapped-tool projection';
}

function reasoningSection(): string {
  return [
    '## Reasoning',
    'Think through tradeoffs privately. Share only the useful conclusion, concrete evidence, and next action.',
    'If assumptions matter, state them plainly. If the task cannot proceed safely, stop and ask for the smallest missing decision.',
  ].join('\n');
}

function publicToolHints(rules: readonly string[]): string[] {
  const out = new Set<string>();
  for (const rule of rules) {
    const trimmed = rule.trim();
    if (!trimmed) continue;
    const gantryMcp = /^mcp__gantry__(.+)$/.exec(trimmed);
    if (gantryMcp?.[1]) {
      out.add(gantryMcp[1]);
      continue;
    }
    const scoped = /^([A-Za-z][A-Za-z0-9_-]*)\((.*)\)$/.exec(trimmed);
    if (scoped?.[1]) {
      out.add(`${publicGantryToolNameForSdkTool(scoped[1])}(<scope>)`);
      continue;
    }
    out.add(publicGantryToolNameForSdkTool(trimmed));
  }
  return [...out].sort();
}

function displayName(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || 'Gantry';
}

function joinSections(sections: readonly string[]): string {
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n');
}
