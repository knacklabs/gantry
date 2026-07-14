import { describe, expect, it } from 'vitest';

import { assertTargetAllowed } from '@core/application/external-ingress/target-policy.js';

describe('external ingress target policy', () => {
  it('rejects explicit conversation agent targets when agent ids are unconstrained', () => {
    expect(() =>
      assertTargetAllowed(
        {
          targetPolicy: {
            allowedTargetKinds: ['conversation_message'],
            conversationIds: ['conversation:tg:-100'],
          },
        },
        {
          kind: 'conversation_message',
          conversationId: 'conversation:tg:-100',
          agentId: 'agent:triage_agent',
        },
      ),
    ).toThrow(
      'Ingress is not allowed to invoke this conversation agent target',
    );
  });

  it('still rejects agent-less conversation targets when agent ids are constrained', () => {
    expect(() =>
      assertTargetAllowed(
        {
          targetPolicy: {
            allowedTargetKinds: ['conversation_message'],
            conversationIds: ['conversation:tg:-100'],
            allowedAgentIds: ['agent:triage_agent'],
          },
        },
        {
          kind: 'conversation_message',
          conversationId: 'conversation:tg:-100',
        },
      ),
    ).toThrow(
      'Ingress is not allowed to invoke this conversation agent target',
    );
  });
});
