import { describe, expect, it } from 'vitest';

import { buildRunnerSystemPrompt } from '@core/adapters/llm/anthropic-claude-agent/runner/system-prompt.js';
import type { AgentRunnerInput } from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';
import { composeDeepAgentSystemPrompt } from '@core/adapters/llm/deepagents-langchain/runner/system-prompt.js';
import type { DeepAgentRunnerInput } from '@core/adapters/llm/deepagents-langchain/runner/types.js';
import { buildGantryAgentSystemPrompt } from '@core/runner/gantry-agent-system-prompt.js';

const FULL_SECTIONS = [
  '## Identity',
  '## Tooling',
  '## Execution Bias',
  '## Safety',
  '## Skills',
  '## Gantry Control',
  '## Self-Update',
  '## Workspace',
  '## Documentation',
  '## Workspace Files',
  '## Sandbox',
  '## Current Date & Time',
  '## Assistant Output Directives',
  '## Runtime',
  '## Reasoning',
];

describe('buildGantryAgentSystemPrompt', () => {
  it('renders the OpenClaw-inspired full section order with stable and dynamic parts split', () => {
    const prompt = buildGantryAgentSystemPrompt({
      runtimeProjection: 'wrapped-tool-projection',
      promptMode: 'full',
      assistantName: 'Asha',
      persona: 'operations',
      compiledSystemPrompt: 'compiled profile',
      hasMemoryContext: true,
      selectedToolRules: [
        'WebFetch',
        'Read',
        'RunCommand(npm test *)',
        'mcp__gantry__mcp_list_tools',
      ],
      workspaceFolder: 'main_agent',
      conversationId: 'tg:team',
      threadId: 'thread-1',
      currentDateTimeIso: '2026-06-17T00:00:00.000Z',
    });

    let previous = -1;
    for (const section of FULL_SECTIONS) {
      const next = prompt.prompt.indexOf(section);
      expect(next, section).toBeGreaterThan(previous);
      previous = next;
    }
    expect(prompt.staticPrompt).toContain('## Identity');
    expect(prompt.staticPrompt).toContain('## Self-Update');
    expect(prompt.staticPrompt).not.toContain('## Documentation');
    expect(prompt.staticPrompt).not.toContain('## Workspace');
    expect(prompt.dynamicPrompt).toContain('## Workspace');
    expect(prompt.dynamicPrompt).toContain('## Documentation');
    expect(prompt.dynamicPrompt).toContain('## Current Date & Time');
    expect(prompt.prompt).toContain('Gantry Durable Memory Boundary');
    expect(prompt.prompt).toContain('compiled profile');
    expect(prompt.prompt).toContain('WebRead');
    expect(prompt.prompt).toContain('FileRead');
    expect(prompt.prompt).toContain('RunCommand(<scope>)');
    expect(prompt.prompt).not.toContain('WebFetch');
    expect(prompt.prompt).not.toContain('DeepAgents');
  });

  it('keeps minimal mode compact for delegated/internal runs', () => {
    const prompt = buildGantryAgentSystemPrompt({
      runtimeProjection: 'native-tool-projection',
      promptMode: 'minimal',
      assistantName: 'Asha',
      currentDateTimeIso: '2026-06-17T00:00:00.000Z',
    });

    expect(prompt.prompt).toContain('## Identity');
    expect(prompt.prompt).toContain('## Tooling');
    expect(prompt.prompt).toContain('## Assistant Output Directives');
    expect(prompt.prompt).not.toContain('## Workspace');
    expect(prompt.prompt).not.toContain('Public Gantry catalog:');
  });

  it('renders none mode as base identity only', () => {
    const prompt = buildGantryAgentSystemPrompt({
      runtimeProjection: 'native-tool-projection',
      promptMode: 'none',
      assistantName: 'Asha',
    });

    expect(prompt.prompt).toContain('## Identity');
    expect(prompt.prompt).not.toContain('## Tooling');
    expect(prompt.dynamicPrompt).toBe('');
  });

  it('includes the required work receipt lines', () => {
    const prompt = buildGantryAgentSystemPrompt({
      runtimeProjection: 'wrapped-tool-projection',
      promptMode: 'full',
      currentDateTimeIso: '2026-06-17T00:00:00.000Z',
    });

    expect(prompt.prompt).toContain('Completed: <short outcome>');
    expect(prompt.prompt).toContain('Used: <tools/capabilities>');
    expect(prompt.prompt).toContain(
      'Changed: <files/accounts/channels or none>',
    );
    expect(prompt.prompt).toContain('Delegated: yes/no');
    expect(prompt.prompt).toContain('Needs attention: <blocker or none>');
  });

  it('uses the unified static/dynamic prompt path for Anthropic personas', () => {
    const input = {
      prompt: 'summarize the plan',
      workspaceFolder: 'main_agent',
      chatJid: 'tg:team',
      persona: 'generalist',
      assistantName: 'Asha',
      promptMode: 'full',
      compiledSystemPrompt: 'custom profile prompt',
      allowedTools: ['Read'],
    } satisfies AgentRunnerInput;

    const prompt = buildRunnerSystemPrompt(input, 'memory context');

    expect(Array.isArray(prompt)).toBe(true);
    if (!Array.isArray(prompt)) throw new Error('expected prompt array');
    expect(prompt).toHaveLength(3);
    expect(prompt[0]).toContain('## Identity');
    expect(prompt[1]).not.toContain('##');
    expect(prompt[2]).toContain('## Workspace');
    expect(prompt[0]).toContain('custom profile prompt');
    expect(prompt[0]).toContain('Gantry Durable Memory Boundary');
    expect(prompt[2]).toContain('Selected public tool hints: FileRead.');
    expect(prompt[2]).not.toContain('Selected public tool hints: Read.');
  });

  it('keeps developer personas on the neutral Gantry prompt path', () => {
    const input = {
      prompt: 'edit the repo',
      workspaceFolder: 'main_agent',
      chatJid: 'tg:team',
      persona: 'developer',
      compiledSystemPrompt: 'developer profile prompt',
    } satisfies AgentRunnerInput;

    const prompt = buildRunnerSystemPrompt(input, 'memory context');

    expect(Array.isArray(prompt)).toBe(true);
    if (!Array.isArray(prompt)) throw new Error('expected prompt array');
    expect(prompt[0]).toContain('## Identity');
    expect(prompt[0]).toContain('Configured working style: developer.');
    expect(prompt[0]).toContain('developer profile prompt');
    expect(prompt[0]).toContain('Gantry Durable Memory Boundary');
    expect(prompt.join('\n')).not.toContain('claude_code');
  });

  it('uses the same unified renderer for DeepAgents developer personas', () => {
    const input = {
      prompt: 'summarize the plan',
      workspaceFolder: 'main_agent',
      chatJid: 'tg:team',
      persona: 'developer',
      assistantName: 'Asha',
      promptMode: 'full',
      compiledSystemPrompt: 'custom profile prompt',
      memoryContextBlock: 'remember this',
      allowedTools: ['WebFetch', 'Read'],
    } satisfies DeepAgentRunnerInput;

    const prompt = composeDeepAgentSystemPrompt(input);

    for (const section of FULL_SECTIONS) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain('custom profile prompt');
    expect(prompt).toContain('Configured working style: developer.');
    expect(prompt).toContain('Gantry Durable Memory Boundary');
    expect(prompt).toContain('WebRead');
    expect(prompt).toContain('FileRead');
    expect(prompt).not.toContain('WebFetch');
    expect(prompt).not.toContain('DeepAgents');
  });
});
