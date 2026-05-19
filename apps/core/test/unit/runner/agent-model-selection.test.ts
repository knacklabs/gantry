import { describe, expect, it } from 'vitest';

import {
  requestedModelFromAgentInput,
  unsupportedAgentConfigurationField,
  validateAgentToolInput,
  validateAgentModelRequest,
} from '@core/adapters/llm/anthropic-claude-agent/runner/agent-model-selection.js';
import { findModelByRunnerModel } from '@core/shared/model-catalog.js';

describe('Agent model selection', () => {
  it('validates Agent model overrides through catalog aliases and provider boundary', () => {
    const sonnet = findModelByRunnerModel('claude-sonnet-4-6');

    expect(
      validateAgentModelRequest(undefined, sonnet).message,
    ).toBeUndefined();
    expect(
      validateAgentModelRequest('inherit', sonnet).message,
    ).toBeUndefined();
    expect(validateAgentModelRequest('opus', sonnet).message).toBeUndefined();
    expect(validateAgentModelRequest('opus 4.7', sonnet).message).toContain(
      'accepts only opus, sonnet, or haiku',
    );
    expect(validateAgentModelRequest('sonet', sonnet).message).toContain(
      'Did you mean "sonnet"',
    );
    expect(validateAgentModelRequest('kimi', sonnet).message).toContain(
      'Cross-provider subagents are not supported',
    );
    expect(
      validateAgentModelRequest('claude-sonnet-4-6', sonnet).message,
    ).toContain('Provider model ID');
    expect(validateAgentModelRequest('opus-4.7', sonnet).message).toContain(
      'accepts only opus, sonnet, or haiku',
    );
  });

  it('extracts native Agent model input defensively', () => {
    expect(requestedModelFromAgentInput({ model: ' sonnet ' })).toBe('sonnet');
    expect(requestedModelFromAgentInput({ model: '' })).toBeUndefined();
    expect(requestedModelFromAgentInput(null)).toBeUndefined();
  });

  it('allows native Agent subagent_type when the Agent capability is granted', () => {
    const sonnet = findModelByRunnerModel('claude-sonnet-4-6');

    expect(
      validateAgentToolInput(
        { prompt: 'review', subagent_type: 'elevated' },
        sonnet,
      ),
    ).toBeNull();
  });

  it('rejects overrides when the parent run model is not cataloged', () => {
    expect(validateAgentModelRequest('sonnet', undefined).message).toContain(
      'cannot be validated because the parent run model is not in the Gantry catalog',
    );
  });

  it('rejects dynamic subagent configuration fields on native Agent input', () => {
    const sonnet = findModelByRunnerModel('claude-sonnet-4-6');

    expect(unsupportedAgentConfigurationField({ tools: ['Read'] })).toBe(
      'tools',
    );
    expect(
      validateAgentToolInput({ prompt: 'review', tools: ['Read'] }, sonnet),
    ).toContain('configured subagent definition');
    expect(
      validateAgentToolInput(
        { prompt: 'review', mcpServers: [{ name: 'docs' }] },
        sonnet,
      ),
    ).toContain('configured subagent definition');
    expect(
      validateAgentToolInput({ prompt: 'review', skills: ['api'] }, sonnet),
    ).toContain('configured subagent definition');
    expect(
      validateAgentToolInput(
        { prompt: 'review', disallowedTools: ['Bash'] },
        sonnet,
      ),
    ).toContain('configured subagent definition');
    expect(
      unsupportedAgentConfigurationField({ mode: 'bypassPermissions' }),
    ).toBe('mode');
    expect(
      validateAgentToolInput(
        { prompt: 'review', mode: 'bypassPermissions' },
        sonnet,
      ),
    ).toContain('permission mode overrides can expand authority');
  });

  it('accepts only native SDK aliases for per-invocation Agent model overrides', () => {
    const sonnet = findModelByRunnerModel('claude-sonnet-4-6');

    expect(
      validateAgentToolInput({ prompt: 'review', model: 'opus' }, sonnet),
    ).toBeNull();
    expect(
      validateAgentToolInput({ prompt: 'review', model: 'sonnet' }, sonnet),
    ).toBeNull();
    expect(
      validateAgentToolInput({ prompt: 'review', model: 'haiku' }, sonnet),
    ).toBeNull();
    expect(
      validateAgentToolInput({ prompt: 'review', model: 'opus 4.7' }, sonnet),
    ).toContain('accepts only opus, sonnet, or haiku');
  });
});
