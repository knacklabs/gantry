import { describe, expect, it } from 'vitest';

import {
  AGENT_ENGINES,
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
  agentEngineLabel,
  isAgentEngine,
} from '@core/shared/agent-engine.js';

describe('agent engine vocabulary', () => {
  it('declares the derived values and the system default', () => {
    expect(AGENT_ENGINES).toEqual(['anthropic_sdk', 'deepagents']);
    expect(DEFAULT_AGENT_ENGINE).toBe('anthropic_sdk');
    expect(DEEPAGENTS_ENGINE).toBe('deepagents');
  });

  it('maps engines to display labels', () => {
    expect(agentEngineLabel(DEFAULT_AGENT_ENGINE)).toBe('Anthropic SDK');
    expect(agentEngineLabel(DEEPAGENTS_ENGINE)).toBe('DeepAgents');
  });

  it('guards engine values', () => {
    expect(isAgentEngine('anthropic_sdk')).toBe(true);
    expect(isAgentEngine('deepagents')).toBe(true);
    expect(isAgentEngine('langchain')).toBe(false);
    expect(isAgentEngine(2)).toBe(false);
  });
});
