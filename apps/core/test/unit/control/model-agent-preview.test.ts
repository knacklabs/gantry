import { describe, expect, it } from 'vitest';

import { agentModelPreview } from '@core/control/server/routes/model-agent-preview.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
  type AgentEngine,
} from '@core/shared/agent-engine.js';

function ctxWith(engine: AgentEngine): ControlRouteContext {
  return {
    getEffectiveAgentEngine: () => engine,
  } as unknown as ControlRouteContext;
}

describe('agentModelPreview', () => {
  it('returns engine, credential profile, and executionProviderId for a compatible pair', () => {
    const result = agentModelPreview(ctxWith(DEEPAGENTS_ENGINE), {
      agentId: 'agent:main_agent',
      modelAlias: 'opus',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      target: 'agent',
      agentId: 'main_agent',
      agentEngine: DEEPAGENTS_ENGINE,
      agentEngineLabel: 'DeepAgents',
      executionProviderId: 'deepagents:langchain',
    });
    expect(result.body.credentialProfile).toBeTruthy();
    expect(result.body.incompatible).toBeUndefined();
  });

  it('surfaces the locked OpenAI/Anthropic-SDK copy in `incompatible` (HTTP 200)', () => {
    const result = agentModelPreview(ctxWith(DEFAULT_AGENT_ENGINE), {
      agentId: 'main_agent',
      modelAlias: 'gpt',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.executionProviderId).toBeUndefined();
    expect(result.body.incompatible).toBe(
      'Model gpt uses the OpenAI endpoint, which is not supported by Anthropic SDK. Choose DeepAgents or an Anthropic-compatible model.',
    );
  });

  it('rejects a missing modelAlias with a 400', () => {
    const result = agentModelPreview(ctxWith(DEFAULT_AGENT_ENGINE), {
      agentId: 'main_agent',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it('rejects an unknown model alias with a 400', () => {
    const result = agentModelPreview(ctxWith(DEFAULT_AGENT_ENGINE), {
      agentId: 'main_agent',
      modelAlias: 'not-a-real-model',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });
});
