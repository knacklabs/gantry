import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveAgentPromptCapabilityCatalog } from '@core/application/agents/agent-prompt-capability-catalog.js';
import { compileSpawnSystemPrompt } from '@core/runtime/agent-spawn-prompt.js';
import {
  buildProviderSessionAccessFingerprint,
  providerSessionAccessFingerprintMatches,
} from '@core/runtime/provider-session-access-fingerprint.js';

describe('provider session access fingerprint', () => {
  afterEach(() => vi.useRealTimers());

  it('uses schema v2 and invalidates when the capability catalog digest changes', () => {
    const first = buildProviderSessionAccessFingerprint({
      accessPreset: 'full',
      toolPolicyRules: ['capability:calendar.manage'],
      capabilityCatalogDigest: 'catalog:first',
    });
    const same = buildProviderSessionAccessFingerprint({
      accessPreset: 'full',
      capabilityCatalogDigest: 'catalog:first',
      toolPolicyRules: ['capability:calendar.manage'],
    });
    const changed = buildProviderSessionAccessFingerprint({
      accessPreset: 'full',
      toolPolicyRules: ['capability:calendar.manage'],
      capabilityCatalogDigest: 'catalog:changed',
    });

    expect(first).toMatch(/^provider-session-access:v2:[0-9a-f]{64}$/);
    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    expect(providerSessionAccessFingerprintMatches(first, same)).toBe(true);
    expect(
      providerSessionAccessFingerprintMatches(
        'provider-session-access:v1:stale',
        first,
      ),
    ).toBe(false);
  });

  it('invalidates when the effective access preset changes', () => {
    const full = buildProviderSessionAccessFingerprint({
      accessPreset: 'full',
      capabilityCatalogDigest: 'catalog:stable',
    });
    const locked = buildProviderSessionAccessFingerprint({
      accessPreset: 'locked',
      capabilityCatalogDigest: 'catalog:stable',
    });

    expect(locked).not.toBe(full);
  });

  it('keeps the catalog, fingerprint, and static prompt prefix stable across per-turn changes', async () => {
    const capability = {
      capabilityId: 'calendar.manage',
      version: 'v1',
      displayName: 'Calendar',
      category: 'productivity',
      risk: 'write' as const,
      can: 'Manage calendar events.',
      cannot: 'Grant additional authority.',
      credentialSource: 'none' as const,
      implementationBindings: [
        { kind: 'adapter' as const, adapterRef: 'test' },
      ],
    };
    const forTurn = async (userMessage: string) => {
      const catalog = await resolveAgentPromptCapabilityCatalog({
        appId: 'app-one',
        agentId: 'agent-one',
        readySemanticCapabilities: [capability],
      });
      const fingerprint = buildProviderSessionAccessFingerprint({
        accessPreset: 'full',
        toolPolicyRules: ['capability:calendar.manage'],
        semanticCapabilities: [capability],
        capabilityCatalogDigest: catalog.digest,
      });
      const staticPrompt = await compileSpawnSystemPrompt({
        group: {
          name: 'Team',
          folder: 'team',
          trigger: '',
          added_at: '2026-01-01T00:00:00.000Z',
          conversationKind: 'dm',
        },
        agentInput: {
          prompt: userMessage,
          workspaceFolder: 'team',
          chatJid: 'tg:1001',
          agentId: 'agent-one',
          capabilityCatalog: catalog,
        },
        appId: 'app-one',
        accessPreset: 'full',
        mcpInventoryToolsMounted: true,
        fileArtifactStore: () => undefined,
        measureAsync: (_name, fn) => fn(),
      });
      return { catalogDigest: catalog.digest, fingerprint, staticPrompt };
    };

    vi.useFakeTimers();
    vi.setSystemTime('2026-07-21T00:00:00.000Z');
    const first = await forTurn('first user message');
    vi.setSystemTime('2026-07-22T12:34:56.000Z');
    const second = await forTurn('different user message');

    expect(first.staticPrompt).toContain('# Capability catalog');
    expect(first.staticPrompt).not.toContain('first user message');
    expect(second.staticPrompt).not.toContain('different user message');
    expect(second.catalogDigest).toBe(first.catalogDigest);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.staticPrompt).toBe(first.staticPrompt);
  });
});
