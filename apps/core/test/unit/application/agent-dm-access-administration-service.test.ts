import { describe, expect, it, vi } from 'vitest';

import { AgentDmAccessAdministrationService } from '@core/application/agents/agent-dm-access-administration-service.js';

const iso = '2026-05-01T00:00:00.000Z';

function createService() {
  const rows: Array<{
    id: string;
    appId: string;
    agentId: string;
    providerId: string;
    externalUserId: string;
    createdAt: string;
    updatedAt: string;
  }> = [];
  const approverRows: Array<{
    id: string;
    appId: string;
    agentId: string;
    providerId: string;
    externalUserId: string;
    createdAt: string;
    updatedAt: string;
  }> = [];
  const agents = [
    {
      id: 'agent:one',
      appId: 'default',
      name: 'One',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: 'agent:two',
      appId: 'default',
      name: 'Two',
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    },
  ];
  const repository = {
    getAgent: vi.fn(async (id: string) => agents.find((a) => a.id === id)),
    listAgentDmAccess: vi.fn(async ({ appId, agentId }: any) =>
      rows.filter((row) => row.appId === appId && row.agentId === agentId),
    ),
    listAgentDmApprovers: vi.fn(async ({ appId, agentId }: any) =>
      approverRows.filter(
        (row) => row.appId === appId && row.agentId === agentId,
      ),
    ),
    replaceAgentDmAccess: vi.fn(async ({ appId, agentId, entries }: any) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index]!.appId === appId && rows[index]!.agentId === agentId) {
          rows.splice(index, 1);
        }
      }
      rows.push(
        ...entries.map((entry: any) => ({
          id: `dm:${agentId}:${entry.providerId}:${entry.externalUserId}`,
          appId,
          agentId,
          providerId: entry.providerId,
          externalUserId: entry.externalUserId,
          createdAt: iso,
          updatedAt: iso,
        })),
      );
      return rows.filter(
        (row) => row.appId === appId && row.agentId === agentId,
      );
    }),
    replaceAgentDmApprovers: vi.fn(async ({ appId, agentId, entries }: any) => {
      for (let index = approverRows.length - 1; index >= 0; index -= 1) {
        if (
          approverRows[index]!.appId === appId &&
          approverRows[index]!.agentId === agentId
        ) {
          approverRows.splice(index, 1);
        }
      }
      approverRows.push(
        ...entries.map((entry: any) => ({
          id: `dm-admin:${agentId}:${entry.providerId}`,
          appId,
          agentId,
          providerId: entry.providerId,
          externalUserId: entry.externalUserId,
          createdAt: iso,
          updatedAt: iso,
        })),
      );
      return approverRows.filter(
        (row) => row.appId === appId && row.agentId === agentId,
      );
    }),
    replaceAgentDmAccessPolicy: vi.fn(async (input: any) => {
      const access = await repository.replaceAgentDmAccess({
        appId: input.appId,
        agentId: input.agentId,
        entries: input.accessEntries,
        updatedAt: input.updatedAt,
      });
      const approvers = await repository.replaceAgentDmApprovers({
        appId: input.appId,
        agentId: input.agentId,
        entries: input.approverEntries,
        updatedAt: input.updatedAt,
      });
      return { access, approvers };
    }),
    findAgentsByDmAccess: vi.fn(async ({ appId, providerId, externalUserId }) =>
      rows
        .filter(
          (row) =>
            row.appId === appId &&
            row.providerId === providerId &&
            row.externalUserId === externalUserId,
        )
        .map((row) => agents.find((agent) => agent.id === row.agentId))
        .filter(Boolean),
    ),
  };
  return {
    rows,
    approverRows,
    repository,
    service: new AgentDmAccessAdministrationService(
      { agents: repository as never },
      { now: () => iso },
    ),
  };
}

describe('AgentDmAccessAdministrationService', () => {
  it('replaces agent DM access deterministically across providers', async () => {
    const { service, repository } = createService();

    const result = await service.replaceDmAccess({
      appId: 'default' as never,
      agentId: 'agent:one' as never,
      entries: [
        { provider: 'Slack', userIds: ['U2', 'U1', 'U1'], adminUserId: 'UA' },
        { provider: 'telegram', userIds: ['123'] },
      ],
    });

    expect(result.dmAccess.entries).toEqual([
      { provider: 'slack', userIds: ['U1', 'U2'], adminUserId: 'UA' },
      { provider: 'telegram', userIds: ['123'] },
    ]);
    expect(repository.replaceAgentDmAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        accessEntries: [
          { providerId: 'slack', externalUserId: 'U1' },
          { providerId: 'slack', externalUserId: 'U2' },
          { providerId: 'telegram', externalUserId: '123' },
        ],
      }),
    );
    expect(repository.replaceAgentDmAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        approverEntries: [{ providerId: 'slack', externalUserId: 'UA' }],
      }),
    );
  });

  it('resolves none, single, and ambiguous DM routing outcomes', async () => {
    const { service } = createService();
    await service.replaceDmAccess({
      appId: 'default' as never,
      agentId: 'agent:one' as never,
      entries: [{ provider: 'teams', userIds: ['user-1'] }],
    });

    expect(
      await service.resolveDmAgent({
        appId: 'default' as never,
        providerId: 'teams',
        externalUserId: 'missing',
      }),
    ).toEqual({ status: 'none' });
    expect(
      await service.resolveDmAgent({
        appId: 'default' as never,
        providerId: 'teams',
        externalUserId: 'user-1',
      }),
    ).toMatchObject({ status: 'single', agent: { id: 'agent:one' } });

    await service.replaceDmAccess({
      appId: 'default' as never,
      agentId: 'agent:two' as never,
      entries: [{ provider: 'teams', userIds: ['user-1'] }],
    });
    expect(
      await service.resolveDmAgent({
        appId: 'default' as never,
        providerId: 'teams',
        externalUserId: 'user-1',
      }),
    ).toMatchObject({ status: 'ambiguous' });
  });

  it('rejects invalid provider and user IDs', async () => {
    const { service } = createService();

    await expect(
      service.replaceDmAccess({
        appId: 'default' as never,
        agentId: 'agent:one' as never,
        entries: [{ provider: 'bad provider', userIds: ['U1'] }],
      }),
    ).rejects.toThrow('Invalid DM access provider');

    await expect(
      service.replaceDmAccess({
        appId: 'default' as never,
        agentId: 'agent:one' as never,
        entries: [{ provider: 'slack', userIds: ['not allowed'] }],
      }),
    ).rejects.toThrow('Invalid DM access user id');
  });

  it('authorizes direct DM approval through the agent DM admin only', async () => {
    const { repository } = createService();
    await repository.replaceAgentDmApprovers({
      appId: 'default',
      agentId: 'agent:one',
      entries: [{ providerId: 'slack', externalUserId: 'UADMIN' }],
      updatedAt: iso,
    });
    const providerConnections = {
      listAgentConversationBindings: vi.fn(async () => [
        {
          agentId: 'agent:one',
          conversationId: 'conversation:sl:D123',
          status: 'active',
        },
      ]),
    };
    const conversations = {
      getConversation: vi.fn(async (conversationId: string) => ({
        id: conversationId,
        appId: 'default',
        providerId: 'slack',
        kind: conversationId.endsWith('D123') ? 'direct' : 'channel',
      })),
    };
    const service = new AgentDmAccessAdministrationService(
      {
        agents: repository as never,
        providerConnections: providerConnections as never,
        conversations: conversations as never,
      },
      { now: () => iso },
    );

    await expect(
      service.isDmApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack',
        channelJid: 'sl:D123',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isDmApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack',
        channelJid: 'sl:D123',
        userId: 'U1',
      }),
    ).resolves.toBe(false);
    await expect(
      service.isDmApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack',
        channelJid: 'sl:C123',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(null);
  });

  it('keeps direct DM admins provider-scoped for the same agent', async () => {
    const { repository } = createService();
    await repository.replaceAgentDmApprovers({
      appId: 'default',
      agentId: 'agent:one',
      entries: [
        { providerId: 'slack', externalUserId: 'UADMIN' },
        { providerId: 'teams', externalUserId: '8:orgid:admin' },
      ],
      updatedAt: iso,
    });
    const service = new AgentDmAccessAdministrationService(
      {
        agents: repository as never,
        providerConnections: {
          listAgentConversationBindings: vi.fn(async () => [
            {
              agentId: 'agent:one',
              conversationId: 'conversation:sl:D123',
              status: 'active',
            },
            {
              agentId: 'agent:one',
              conversationId: 'conversation:teams:D123',
              status: 'active',
            },
          ]),
        } as never,
        conversations: {
          getConversation: vi.fn(async (conversationId: string) => ({
            id: conversationId,
            appId: 'default',
            kind: 'direct',
          })),
        } as never,
      },
      { now: () => iso },
    );

    await expect(
      service.isDmApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack',
        channelJid: 'sl:D123',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isDmApproverAllowed({
        appId: 'default' as never,
        providerId: 'teams',
        channelJid: 'teams:D123',
        userId: '8:orgid:admin',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isDmApproverAllowed({
        appId: 'default' as never,
        providerId: 'teams',
        channelJid: 'teams:D123',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(false);
    await expect(
      service.isDmApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack',
        channelJid: 'sl:D123',
        userId: '8:orgid:admin',
      }),
    ).resolves.toBe(false);
  });

  it('fails closed when a direct conversation has multiple active bindings', async () => {
    const { repository } = createService();
    await repository.replaceAgentDmApprovers({
      appId: 'default',
      agentId: 'agent:one',
      entries: [{ providerId: 'slack', externalUserId: 'UADMIN' }],
      updatedAt: iso,
    });
    const service = new AgentDmAccessAdministrationService(
      {
        agents: repository as never,
        providerConnections: {
          listAgentConversationBindings: vi.fn(async () => [
            {
              agentId: 'agent:one',
              conversationId: 'conversation:sl:D123',
              status: 'active',
            },
            {
              agentId: 'agent:two',
              conversationId: 'conversation:sl:D123',
              status: 'active',
            },
          ]),
        } as never,
        conversations: {
          getConversation: vi.fn(async () => ({
            id: 'conversation:sl:D123',
            appId: 'default',
            kind: 'direct',
          })),
        } as never,
      },
      { now: () => iso },
    );

    await expect(
      service.isDmApproverAllowed({
        appId: 'default' as never,
        providerId: 'slack',
        channelJid: 'sl:D123',
        userId: 'UADMIN',
      }),
    ).resolves.toBe(false);
  });
});
