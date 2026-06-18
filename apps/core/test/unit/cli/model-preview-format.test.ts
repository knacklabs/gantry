import { describe, expect, it } from 'vitest';

import {
  formatPreviewWhy,
  parseAgentFlag,
} from '@core/cli/model-preview-format.js';

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

describe('formatPreviewWhy for an agent harness/route preview', () => {
  it('renders harness, credential profile, and executionProviderId', () => {
    const output = formatPreviewWhy({
      target: 'agent',
      agentId: 'main_agent',
      agentHarness: 'deepagents',
      credentialProfile: 'anthropic-default',
      executionProviderId: 'deepagents:langchain',
      selection: {
        effectiveAlias: 'opus',
        source: 'agent main_agent harness deepagents',
        inherited: false,
        model: { displayName: 'Opus 4.8', responseFamily: 'anthropic' },
      },
      why: [
        'agent main_agent uses deepagents harness on the anthropic endpoint',
      ],
    });
    expect(output).toContain('Why agent main_agent uses this model');
    expect(output).toContain('agent harness: deepagents');
    expect(output).not.toContain('agent engine:');
    expect(output).toContain('response family: anthropic');
    expect(output).toContain('credential profile: anthropic-default');
    expect(output).toContain('execution provider id: deepagents:langchain');
    expect(output).not.toContain('incompatible:');
  });

  it('renders the locked incompatibility copy when present', () => {
    const output = formatPreviewWhy({
      target: 'agent',
      agentId: 'main_agent',
      agentHarness: 'anthropic_sdk',
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
