import { describe, expect, it, vi } from 'vitest';

import { PostgresRuntimeRepositoryBundle } from '@core/adapters/storage/postgres/schema/canonical-ops-repo.postgres.js';
import { CanonicalSessionOpsService } from '@core/adapters/storage/postgres/services/canonical-session-ops-service.js';
import {
  makeOwnedAgentSessionScopeKey,
  type PostgresCanonicalSessionRepository,
} from '@core/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';
import type {
  AgentSessionDigestRepository,
  AgentSessionRepository,
} from '@core/domain/ports/repositories.js';
import type {
  AgentSession,
  AgentSessionDigest,
} from '@core/domain/sessions/sessions.js';

const now = '2026-05-08T00:00:00.000Z';

function makeBundleWithSessionService(input: {
  repository: PostgresCanonicalSessionRepository;
  agentSessions: AgentSessionRepository;
  agentSessionDigests?: AgentSessionDigestRepository;
  loadAppMemoryItems: NonNullable<
    ConstructorParameters<typeof PostgresRuntimeRepositoryBundle>[2]['sessions']
  >['loadAppMemoryItems'];
}): PostgresRuntimeRepositoryBundle {
  const bundle = new PostgresRuntimeRepositoryBundle(
    { end: vi.fn(async () => undefined) } as any,
    {} as any,
    {
      runtimeEvents: { publish: vi.fn(async () => undefined) },
      sessions: {
        memoryItemLimit: 3,
        loadAppMemoryItems: input.loadAppMemoryItems,
      },
    },
  );

  Object.assign(bundle as any, {
    sessions: new CanonicalSessionOpsService(
      input.repository,
      {
        agentSessions: input.agentSessions,
        agentSessionDigests: input.agentSessionDigests,
        loadAppMemoryItems: input.loadAppMemoryItems,
      },
      { memoryItemLimit: 3 },
    ),
  });

  return bundle;
}

describe('PostgresRuntimeRepositoryBundle', () => {
  it('includes resolved canonical agent ownership in provider session scope keys', () => {
    const routeScope =
      'runtime_workspace_folder::conversation:tg%3Asession-rebind';

    expect(makeOwnedAgentSessionScopeKey('agent:agent_a', routeScope)).toBe(
      'agent:agent%3Aagent_a::runtime_workspace_folder::conversation:tg%3Asession-rebind',
    );
    expect(makeOwnedAgentSessionScopeKey('agent:agent_a', routeScope)).not.toBe(
      makeOwnedAgentSessionScopeKey('agent:agent_b', routeScope),
    );
    expect(
      makeOwnedAgentSessionScopeKey('agent:agent_a', routeScope, 'app:one'),
    ).toBe(
      'app:app%3Aone::agent:agent%3Aagent_a::runtime_workspace_folder::conversation:tg%3Asession-rebind',
    );
    expect(
      makeOwnedAgentSessionScopeKey('agent:agent_a', routeScope, 'app:one'),
    ).not.toBe(
      makeOwnedAgentSessionScopeKey('agent:agent_a', routeScope, 'app:two'),
    );
    expect(makeOwnedAgentSessionScopeKey('agent:agent_a', routeScope)).not.toBe(
      makeOwnedAgentSessionScopeKey('agent:agent_a', routeScope, 'app:one'),
    );
  });

  it('forwards hydrateMemory:false to skip concrete session memory hydration', async () => {
    const session: AgentSession = {
      id: 'agent-session:main' as never,
      appId: 'app:default' as never,
      agentId: 'agent:main' as never,
      status: 'active',
      createdAt: now as never,
      updatedAt: now as never,
    };
    const repository = {
      getAgentTurnContext: vi.fn(async () => ({
        appId: 'app:default',
        agentId: 'agent:main',
        agentSessionId: 'agent-session:main',
      })),
    } as unknown as PostgresCanonicalSessionRepository;
    const agentSessions = {
      getAgentSession: vi.fn(async () => session),
    } as unknown as AgentSessionRepository;
    const loadAppMemoryItems = vi.fn(async () => [
      {
        id: 'memory:item:1',
        kind: 'preference',
        key: 'preference:style',
        value: 'Prefer concise replies.',
        subject: {},
      },
    ]);
    const bundle = makeBundleWithSessionService({
      repository,
      agentSessions,
      loadAppMemoryItems,
    });

    const archivedLookup = await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'tg:primary',
      threadId: 'topic-1',
      conversationKind: 'channel',
      query: 'remember style',
      hydrateMemory: false,
    });

    expect(archivedLookup.memoryContextBlock).toBeUndefined();
    expect(agentSessions.getAgentSession).not.toHaveBeenCalled();
    expect(loadAppMemoryItems).not.toHaveBeenCalled();

    const hydratedLookup = await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'tg:primary',
      threadId: 'topic-1',
      conversationKind: 'channel',
      query: 'remember style',
    });

    expect(hydratedLookup.memoryContextBlock).toContain('preference:style');
    expect(agentSessions.getAgentSession).toHaveBeenCalledWith(
      'agent-session:main',
    );
    expect(loadAppMemoryItems).toHaveBeenCalledWith({
      session,
      limit: 3,
      query: 'remember style',
      conversationKind: 'channel',
      hydrationMode: 'full',
    });

    await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'tg:primary',
      threadId: 'topic-1',
      conversationKind: 'channel',
      query: 'remember style',
      hydrationMode: 'first_visible',
    });

    expect(loadAppMemoryItems).toHaveBeenLastCalledWith({
      session,
      limit: 3,
      query: 'remember style',
      conversationKind: 'channel',
      hydrationMode: 'first_visible',
      statementTimeoutMs: 250,
    });
  });

  it('uses exact conversation and thread scope keys for provider session resume', async () => {
    const seenScopes: string[] = [];
    const repository = {
      getAgentTurnContext: vi.fn(async (input) => {
        seenScopes.push(input.scopeKey);
        return {
          appId: 'app:default',
          agentId: 'agent:main',
          agentSessionId: `agent-session:${input.scopeKey}`,
        };
      }),
      setProviderSession: vi.fn(async (input) => {
        seenScopes.push(input.scopeKey);
      }),
    } as unknown as PostgresCanonicalSessionRepository;
    const agentSessions = {
      getAgentSession: vi.fn(async () => null),
    } as unknown as AgentSessionRepository;
    const bundle = makeBundleWithSessionService({
      repository,
      agentSessions,
      loadAppMemoryItems: vi.fn(async () => []),
    });

    await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'sl:D-A',
      conversationKind: 'dm',
      memoryUserId: 'sl:U-A',
      hydrateMemory: false,
    });
    await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'sl:D-B',
      conversationKind: 'dm',
      memoryUserId: 'sl:U-B',
      hydrateMemory: false,
    });
    await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'sl:C-A',
      conversationKind: 'channel',
      memoryUserId: 'sl:U-A',
      hydrateMemory: false,
    });
    await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'sl:C-B',
      conversationKind: 'channel',
      memoryUserId: 'sl:U-B',
      hydrateMemory: false,
    });
    await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'sl:C-A',
      conversationKind: 'channel',
      memoryUserId: 'sl:U-A',
      threadId: '111.222',
      hydrateMemory: false,
    });
    await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'sl:C-A',
      conversationKind: 'channel',
      memoryUserId: 'sl:U-B',
      threadId: '333.444',
      hydrateMemory: false,
    });
    await bundle.setSession('main', 'provider-session:next', '111.222', {
      conversationJid: 'sl:C-A',
      conversationKind: 'channel',
      memoryUserId: 'sl:U-Z',
      expectedAgentSessionId:
        'agent-session:main::conversation:sl%3AC-A::thread:111.222',
      expectedAgentSessionResetAt: null,
    });

    expect(new Set(seenScopes).size).toBe(6);
    expect(seenScopes[4]).toBe(seenScopes[6]);
    expect(repository.getAgentTurnContext).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        scopeKey: 'main::conversation:sl%3AD-A::user:sl%3AU-A',
      }),
    );
    expect(repository.getAgentTurnContext).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        scopeKey: 'main::conversation:sl%3AC-A::thread:111.222',
      }),
    );
    expect(repository.setProviderSession).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'main::conversation:sl%3AC-A::thread:111.222',
        chatJid: 'sl:C-A',
        threadId: '111.222',
        conversationKind: 'channel',
        memoryUserId: 'sl:U-Z',
        expectedAgentSessionId:
          'agent-session:main::conversation:sl%3AC-A::thread:111.222',
        expectedAgentSessionResetAt: null,
      }),
    );
  });

  it('resets provider session state without deleting scoped digest hydration', async () => {
    const session: AgentSession = {
      id: 'agent-session:main::conversation:sl%3AC-A::thread:111.222' as never,
      appId: 'app:default' as never,
      agentId: 'agent:main' as never,
      conversationId: 'conversation:sl:C-A' as never,
      threadId: 'thread:sl:C-A:111.222' as never,
      userId: 'main::conversation:sl%3AC-A::thread:111.222',
      status: 'active',
      createdAt: now as never,
      updatedAt: now as never,
    };
    const digest: AgentSessionDigest = {
      id: 'agent-session-digest:reset-survives' as never,
      appId: session.appId,
      agentSessionId: session.id,
      trigger: 'session-end',
      digest: 'Digest from before /new survives provider-session reset.',
      messageCount: 2,
      extractedFactCount: 0,
      metadata: {
        sessionScope: {
          appId: session.appId,
          agentId: session.agentId,
          conversationId: session.conversationId,
          userId: session.userId,
          threadId: session.threadId,
        },
      },
      createdAt: now as never,
    };
    let providerCleared = false;
    const repository = {
      resetScope: vi.fn(async () => {
        providerCleared = true;
      }),
      getAgentTurnContext: vi.fn(async () => ({
        appId: session.appId,
        agentId: session.agentId,
        agentSessionId: session.id,
        ...(providerCleared
          ? {}
          : {
              providerSessionId: 'provider-session:old',
              externalSessionId: 'provider-external-old',
            }),
      })),
    } as unknown as PostgresCanonicalSessionRepository;
    const agentSessions = {
      getAgentSession: vi.fn(async () => session),
    } as unknown as AgentSessionRepository;
    const agentSessionDigests = {
      getAgentSessionDigest: vi.fn(async () => digest),
      listAgentSessionDigests: vi.fn(async () => [digest]),
      saveAgentSessionDigest: vi.fn(),
    } as unknown as AgentSessionDigestRepository;
    const bundle = makeBundleWithSessionService({
      repository,
      agentSessions,
      agentSessionDigests,
      loadAppMemoryItems: vi.fn(async () => []),
    });

    await bundle.deleteSession('main', '111.222', {
      conversationJid: 'sl:C-A',
      conversationKind: 'channel',
      memoryUserId: 'sl:U-A',
    });
    const hydrated = (await bundle.getAgentTurnContext({
      agentFolder: 'main',
      conversationJid: 'sl:C-A',
      conversationKind: 'channel',
      memoryUserId: 'sl:U-A',
      threadId: '111.222',
    })) as Awaited<ReturnType<typeof bundle.getAgentTurnContext>> & {
      providerSessionId?: string;
      externalSessionId?: string;
    };

    expect(repository.resetScope).toHaveBeenCalledWith({
      appId: undefined,
      scopeKey: 'main::conversation:sl%3AC-A::thread:111.222',
      chatJid: 'sl:C-A',
      threadId: '111.222',
    });
    expect(hydrated.providerSessionId).toBeUndefined();
    expect(hydrated.externalSessionId).toBeUndefined();
    expect(hydrated.memoryContextBlock).toContain('recent_session_digests');
    expect(hydrated.memoryContextBlock).toContain(
      'Digest from before /new survives provider-session reset.',
    );
  });

  it('resets bare group scope when deleteSession metadata is omitted', async () => {
    const repository = {
      resetScope: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalSessionRepository;
    const agentSessions = {
      getAgentSession: vi.fn(async () => null),
    } as unknown as AgentSessionRepository;
    const bundle = makeBundleWithSessionService({
      repository,
      agentSessions,
      loadAppMemoryItems: vi.fn(async () => []),
    });

    await bundle.deleteSession('main', null);

    expect(repository.resetScope).toHaveBeenCalledWith({
      appId: undefined,
      scopeKey: 'main',
      chatJid: undefined,
      threadId: null,
    });
  });

  it('forwards strict provider-session expiry ownership predicates', async () => {
    const repository = {
      expireProviderSession: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalSessionRepository;
    const agentSessions = {
      getAgentSession: vi.fn(async () => null),
    } as unknown as AgentSessionRepository;
    const bundle = makeBundleWithSessionService({
      repository,
      agentSessions,
      loadAppMemoryItems: vi.fn(async () => []),
    });

    await bundle.expireProviderSession({
      providerSessionId: 'provider-session:test:1',
      agentSessionId: 'agent-session:test:1',
      provider: 'anthropic',
      externalSessionId: 'claude-session-1',
    });

    expect(repository.expireProviderSession).toHaveBeenCalledWith({
      providerSessionId: 'provider-session:test:1',
      agentSessionId: 'agent-session:test:1',
      provider: 'anthropic',
      externalSessionId: 'claude-session-1',
    });
  });
});
