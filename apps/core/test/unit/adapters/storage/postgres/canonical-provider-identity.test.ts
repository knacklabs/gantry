import { describe, expect, it } from 'vitest';

import '@core/channels/register-builtins.js';
import {
  agentIdForFolder,
  providerIdForJid,
} from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';

describe('canonical storage provider identity', () => {
  it('stores canonical provider IDs for provider-prefixed JIDs', () => {
    expect(providerIdForJid('tg:-100123')).toBe('telegram');
    expect(providerIdForJid('sl:C123')).toBe('slack');
    expect(providerIdForJid('teams:19:abc@thread.v2')).toBe('teams');
  });

  it('keeps canonical agent ids idempotent', () => {
    expect(agentIdForFolder('triage')).toBe('agent:triage');
    expect(agentIdForFolder('agent:triage')).toBe('agent:triage');
  });
});
