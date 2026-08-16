import { describe, expect, it } from 'vitest';

import {
  resolveTurnSelectedMcpServerIdsFromSnapshot,
  resolveTurnSemanticCapabilitiesFromSnapshot,
} from '@core/runtime/group-run-context.js';
import {
  buildLocalCliSemanticCapability,
  semanticCapabilityInputSchema,
} from '@core/shared/semantic-capabilities.js';

const recipeCapability = {
  ...buildLocalCliSemanticCapability({
    capabilityId: 'manipal.website-recipe-evaluator',
    displayName: 'Website Recipe Evaluator',
    category: 'website_recipe',
    risk: 'write',
    can: 'Evaluate candidate recipes.',
    cannot: 'Browse arbitrary private systems.',
    executablePath: '/usr/local/bin/recipe-evaluator',
    executableVersion: 'v1.0.0',
    executableHash: 'sha256:recipe-evaluator',
    commandTemplates: ['/usr/local/bin/recipe-evaluator evaluate *'],
  }),
  version: '1',
};

const recipeCapabilityTool = {
  id: 'tool:recipe-evaluator',
  appId: 'app:test',
  name: 'capability:manipal.website-recipe-evaluator',
  kind: 'host',
  provider: 'test',
  displayName: 'Website Recipe Evaluator',
  description: 'Evaluate candidate recipes.',
  category: 'productivity',
  status: 'active',
  risk: 'high',
  selectable: true,
  adapterRef: 'test',
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  inputSchema: semanticCapabilityInputSchema(recipeCapability),
};

describe('turn MCP source selection', () => {
  it('projects a routed source only for its matching live conversation and thread', () => {
    const binding = {
      serverId: 'mcp:sum',
      status: 'active',
      conversationId: 'conversation:approved',
      threadId: 'thread:approved',
    };
    const snapshot = {
      appId: 'app:test',
      agentId: 'agent:main',
      tools: { activeBindings: [], appActiveDefinitions: [] },
      skills: { activeBindings: [], enabledDefinitions: [] },
      mcp: {
        activeBindings: [
          {
            binding,
            definition: {
              id: 'mcp:sum',
              appId: 'app:test',
              name: 'sum',
            },
          },
        ],
        materializedServers: [],
      },
    } as never;

    expect(
      resolveTurnSelectedMcpServerIdsFromSnapshot(snapshot, {
        conversationId: 'conversation:approved',
        threadId: 'thread:approved',
      }),
    ).toEqual(['mcp:sum']);
    expect(
      resolveTurnSelectedMcpServerIdsFromSnapshot(snapshot, {
        conversationId: 'conversation:other',
        threadId: 'thread:approved',
      }),
    ).toEqual([]);
    expect(
      resolveTurnSelectedMcpServerIdsFromSnapshot(snapshot, {
        conversationId: 'conversation:approved',
        threadId: 'thread:other',
      }),
    ).toEqual([]);
  });
});

describe('turn semantic capability selection', () => {
  it('does not project an app capability that is not bound to the current agent', () => {
    const snapshot = {
      appId: 'app:test',
      agentId: 'agent:source-discovery',
      tools: {
        activeBindings: [],
        appActiveDefinitions: [recipeCapabilityTool],
      },
      skills: { activeBindings: [], enabledDefinitions: [] },
      mcp: { activeBindings: [], materializedServers: [] },
    } as never;

    expect(resolveTurnSemanticCapabilitiesFromSnapshot(snapshot)).toEqual([]);
  });

  it('projects a semantic capability bound to the current agent', () => {
    const snapshot = {
      appId: 'app:test',
      agentId: 'agent:recipe',
      tools: {
        activeBindings: [
          {
            binding: {
              appId: 'app:test',
              agentId: 'agent:recipe',
              toolId: recipeCapabilityTool.id,
              status: 'active',
            },
            definition: recipeCapabilityTool,
          },
        ],
        appActiveDefinitions: [recipeCapabilityTool],
      },
      skills: { activeBindings: [], enabledDefinitions: [] },
      mcp: { activeBindings: [], materializedServers: [] },
    } as never;

    expect(resolveTurnSemanticCapabilitiesFromSnapshot(snapshot)).toEqual([
      expect.objectContaining({
        capabilityId: 'manipal.website-recipe-evaluator',
        version: '1',
      }),
    ]);
  });
});
