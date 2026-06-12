import { describe, expect, it } from 'vitest';

import {
  formatPreviewWhy,
  parseAgentFlag,
} from '@core/cli/model-preview-format.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
} from '@core/shared/agent-engine.js';

describe('parseAgentFlag', () => {
  it('returns undefined when the flag is absent', () => {
    expect(parseAgentFlag(['opus'])).toBeUndefined();
  });

  it('parses --agent <id> and --agent=<id>', () => {
    expect(parseAgentFlag(['opus', '--agent', 'main_agent'])).toBe(
      'main_agent',
    );
    expect(parseAgentFlag(['opus', '--agent=main_agent'])).toBe('main_agent');
  });

  it('returns an empty string when the flag has no value', () => {
    expect(parseAgentFlag(['opus', '--agent'])).toBe('');
  });
});

describe('formatPreviewWhy for an agent engine/route preview', () => {
  it('renders engine, credential profile, and executionProviderId', () => {
    const output = formatPreviewWhy({
      target: 'agent',
      agentId: 'main_agent',
      agentEngine: DEEPAGENTS_ENGINE,
      agentEngineLabel: 'DeepAgents',
      credentialProfile: 'anthropic-default',
      executionProviderId: 'deepagents:langchain',
      selection: {
        effectiveAlias: 'opus',
        source: 'agent main_agent engine deepagents',
        inherited: false,
        model: { displayName: 'Opus 4.8', responseFamily: 'anthropic' },
      },
      why: ['agent main_agent runs DeepAgents on the anthropic endpoint'],
    });
    expect(output).toContain('Why agent main_agent uses this model');
    expect(output).toContain('agent engine: DeepAgents');
    expect(output).toContain('response family: anthropic');
    expect(output).toContain('credential profile: anthropic-default');
    expect(output).toContain('execution provider id: deepagents:langchain');
    expect(output).not.toContain('incompatible:');
  });

  it('renders the locked incompatibility copy when present', () => {
    const output = formatPreviewWhy({
      target: 'agent',
      agentId: 'main_agent',
      agentEngine: DEFAULT_AGENT_ENGINE,
      agentEngineLabel: 'Anthropic SDK',
      credentialProfile: 'openai-default',
      incompatible:
        'Model gpt uses the OpenAI endpoint, which is not supported by Anthropic SDK. Choose DeepAgents or an Anthropic-compatible model.',
      selection: { effectiveAlias: 'gpt', source: 'x', inherited: false },
      why: ['x'],
    });
    expect(output).toContain(
      'incompatible: Model gpt uses the OpenAI endpoint, which is not supported by Anthropic SDK. Choose DeepAgents or an Anthropic-compatible model.',
    );
    expect(output).not.toContain('execution provider id:');
  });
});
