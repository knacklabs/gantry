import { describe, expect, it } from 'vitest';

import { agentModelPreview } from '@core/control/server/routes/model-agent-preview.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import type { AgentHarness } from '@core/shared/agent-engine.js';

const ctx = (agentHarness: AgentHarness = 'auto') =>
  ({
    getSelectedAgentHarness: () => agentHarness,
  }) as unknown as ControlRouteContext;

describe('agentModelPreview', () => {
  it('reports the selected harness + executionProviderId for an anthropic model', () => {
    const result = agentModelPreview(ctx(), {
      agentId: 'agent:main_agent',
      modelAlias: 'opus',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      target: 'agent',
      agentId: 'main_agent',
      agentHarness: 'auto',
      executionProviderId: 'anthropic:claude-agent-sdk',
    });
    expect(result.body.credentialProfile).toBeTruthy();
  });

  it('accepts an explicit deepagents harness for an openai model', () => {
    const result = agentModelPreview(ctx('deepagents'), {
      agentId: 'main_agent',
      modelAlias: 'gpt',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      agentHarness: 'deepagents',
      executionProviderId: 'deepagents:langchain',
    });
  });

  it('rejects an explicit incompatible harness before runner spawn', () => {
    const result = agentModelPreview(ctx('anthropic_sdk'), {
      agentId: 'main_agent',
      modelAlias: 'gpt',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.message).toContain('agent harness anthropic_sdk');
  });

  it('rejects a missing modelAlias with a 400', () => {
    const result = agentModelPreview(ctx(), {
      agentId: 'main_agent',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it('rejects an unknown model alias with a 400', () => {
    const result = agentModelPreview(ctx(), {
      agentId: 'main_agent',
      modelAlias: 'not-a-real-model',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });
});
