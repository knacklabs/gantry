import { describe, expect, it } from 'vitest';

import { agentModelPreview } from '@core/control/server/routes/model-agent-preview.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import { DEFAULT_AGENT_ENGINE } from '@core/shared/agent-engine.js';

const ctx = {} as unknown as ControlRouteContext;

describe('agentModelPreview', () => {
  it('derives the SDK engine + executionProviderId from an anthropic model', () => {
    const result = agentModelPreview(ctx, {
      agentId: 'agent:main_agent',
      modelAlias: 'opus',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      target: 'agent',
      agentId: 'main_agent',
      agentEngine: DEFAULT_AGENT_ENGINE,
      agentEngineLabel: 'Anthropic SDK',
      executionProviderId: 'anthropic:claude-agent-sdk',
    });
    expect(result.body.credentialProfile).toBeTruthy();
  });

  it('derives the deepagents engine + executionProviderId from an openai model', () => {
    const result = agentModelPreview(ctx, {
      agentId: 'main_agent',
      modelAlias: 'gpt',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      agentEngine: 'deepagents',
      agentEngineLabel: 'DeepAgents',
      executionProviderId: 'deepagents:langchain',
    });
  });

  it('rejects a missing modelAlias with a 400', () => {
    const result = agentModelPreview(ctx, {
      agentId: 'main_agent',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it('rejects an unknown model alias with a 400', () => {
    const result = agentModelPreview(ctx, {
      agentId: 'main_agent',
      modelAlias: 'not-a-real-model',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });
});
