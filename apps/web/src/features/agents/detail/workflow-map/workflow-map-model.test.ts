import { describe, expect, it } from 'vitest';

import type {
  AgentDirectoryItem,
  AgentWorkflowMap,
} from '../../agents-queries';
import { workflowCards } from './workflow-map-model';

const agent: AgentDirectoryItem = {
  id: 'agent:atlas',
  name: 'Atlas',
  status: 'active',
  roleId: null,
  roleName: 'General assistant',
  rolePrompt: null,
  configVersion: 1,
  modelAlias: 'opus',
  conversationCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('workflowCards', () => {
  it('maps every relationship to its destination tab', () => {
    const map: AgentWorkflowMap = {
      relationships: [
        {
          id: 'c',
          kind: 'conversation',
          title: '#general',
          providerLabel: 'Slack',
          status: 'active',
        },
        {
          id: 'j',
          kind: 'job',
          name: 'Digest',
          schedule: 'cron · 0 9 * * *',
          status: 'active',
          nextRun: null,
        },
        {
          id: 'm',
          kind: 'model',
          alias: 'opus',
          displayName: 'Opus 5',
          provider: 'Anthropic',
        },
        { id: 's', kind: 'skill', name: 'Research', sourceStatus: 'installed' },
        {
          id: 'a',
          kind: 'approver',
          displayName: 'Priya',
          conversationId: 'conversation:general',
          conversation: '#general',
        },
      ],
    };
    const cards = workflowCards(agent, map);
    expect(cards.inputs.map((node) => node.targetTab)).toEqual([
      'conversations',
      'jobs',
    ]);
    expect(cards.outputs.map((node) => node.targetTab)).toEqual([
      'access',
      'access',
      'approvals',
    ]);
    expect(cards.employee.targetTab).toBe('overview');
  });

  it('supplies honest empty-state nodes', () => {
    const cards = workflowCards(agent, { relationships: [] });
    expect(cards.inputs.map((node) => node.title)).toEqual([
      'No channel connected',
      'No schedule yet',
    ]);
    expect(cards.outputs.map((node) => node.title)).toEqual([
      'Deployment default',
      'No sources attached',
      'No approver assigned',
    ]);
  });
});
