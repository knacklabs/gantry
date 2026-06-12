import { describe, expect, it, vi } from 'vitest';

import { CanonicalJobOpsService } from '@core/adapters/storage/postgres/services/canonical-job-ops-service.js';
import type { PostgresCanonicalJobRepository } from '@core/adapters/storage/postgres/repositories/canonical-job-repository.postgres.js';

describe('CanonicalJobOpsService', () => {
  it('persists execution context and notification routes without job capability policy', async () => {
    const repository = {
      findJobById: vi.fn(async () => null),
      upsertJob: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.upsertJob({
      id: 'job-1',
      name: 'Job',
      prompt: 'Run',
      schedule_type: 'interval',
      schedule_value: '60000',
      execution_context: {
        conversationJid: 'tg:1',
        threadId: null,
        workspaceKey: 'agent_one',
        sessionId: 'session-1',
      },
      notification_routes: [
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'Primary',
        },
      ],
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
      workspace_key: '',
    });

    const stored = vi.mocked(repository.upsertJob).mock.calls[0]?.[0] as {
      targetJson: string;
    };
    const target = JSON.parse(stored.targetJson) as Record<string, unknown>;
    expect(target.capabilityPolicy).toBeUndefined();
    expect(target.executionContext).toEqual({
      conversationJid: 'tg:1',
      threadId: null,
      workspaceKey: 'agent_one',
      sessionId: 'session-1',
    });
    expect(target.notificationRoutes).toEqual([
      {
        conversationJid: 'tg:1',
        threadId: null,
        label: 'Primary',
      },
    ]);
    expect(target.accessRequirements).toEqual([
      { target: { kind: 'tool_rule', rule: 'Browser' } },
    ]);
  });

  it('merges canonical session_id into executionContext when target sessionId is missing', async () => {
    const repository = {
      findJobById: vi.fn(async () => null),
      upsertJob: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.upsertJob({
      id: 'job-1',
      name: 'Job',
      prompt: 'Run',
      schedule_type: 'interval',
      schedule_value: '60000',
      session_id: 'session-canonical',
      execution_context: {
        conversationJid: 'tg:1',
        threadId: null,
        workspaceKey: 'agent_one',
      },
      notification_routes: [
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'Primary',
        },
      ],
      workspace_key: '',
    });

    const stored = vi.mocked(repository.upsertJob).mock.calls[0]?.[0] as {
      targetJson: string;
    };
    const target = JSON.parse(stored.targetJson) as Record<string, unknown>;
    expect(target.executionContext).toEqual({
      conversationJid: 'tg:1',
      threadId: null,
      workspaceKey: 'agent_one',
      sessionId: 'session-canonical',
    });
  });

  it('projects target routing context into job records', async () => {
    const repository = {
      findJobById: vi.fn(async () => ({
        id: 'job-1',
        agentId: 'agent:agent_one',
        name: 'Job',
        prompt: 'Run',
        model: null,
        scheduleJson: JSON.stringify({ type: 'interval', value: '60000' }),
        status: 'active',
        targetJson: JSON.stringify({
          executionContext: {
            conversationJid: 'tg:1',
            threadId: null,
            workspaceKey: 'agent_one',
            sessionId: 'session-1',
          },
          notificationRoutes: [
            {
              conversationJid: 'tg:1',
              threadId: null,
              label: 'Primary',
            },
          ],
          accessRequirements: [
            { target: { kind: 'tool_rule', rule: 'Browser' } },
          ],
        }),
        silent: false,
        timeoutMs: 300000,
        maxRetries: 3,
        retryBackoffMs: 5000,
        nextRunAt: null,
        lastRunAt: null,
        leaseRunId: null,
        leaseExpiresAt: null,
        createdAt: '2026-04-24T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      })),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await expect(service.getJobById('job-1')).resolves.toMatchObject({
      session_id: 'session-1',
      thread_id: null,
      workspace_key: 'agent_one',
      execution_context: {
        conversationJid: 'tg:1',
        threadId: null,
        workspaceKey: 'agent_one',
        sessionId: 'session-1',
      },
      notification_routes: [
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'Primary',
        },
      ],
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
    });
  });

  it('round-trips job recovery intent through target metadata', async () => {
    const repository = {
      findJobById: vi.fn(async () => null),
      upsertJob: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.upsertJob({
      id: 'job-1',
      name: 'Job',
      prompt: 'Run',
      schedule_type: 'interval',
      schedule_value: '60000',
      execution_context: {
        conversationJid: 'tg:1',
        threadId: null,
        workspaceKey: 'agent_one',
      },
      notification_routes: [
        {
          conversationJid: 'tg:1',
          threadId: null,
          label: 'Primary',
        },
      ],
      workspace_key: 'agent_one',
      recovery_intent: {
        kind: 'permission_denied',
        state: 'pending',
        dedupe_key: 'dedupe-1',
        created_at: '2026-04-24T00:00:00.000Z',
        updated_at: '2026-04-24T00:00:01.000Z',
        source_run_id: 'run-1',
        setup_fingerprint: 'fingerprint-1',
        requirement_type: 'tool',
        requirement_id: 'RunCommand',
        next_action:
          'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
        attempts: 0,
        last_error: null,
      },
    });

    const stored = vi.mocked(repository.upsertJob).mock.calls[0]?.[0] as {
      targetJson: string;
    };
    expect(JSON.parse(stored.targetJson)).toMatchObject({
      recoveryIntent: {
        kind: 'permission_denied',
        state: 'pending',
        dedupe_key: 'dedupe-1',
        requirement_id: 'RunCommand',
      },
    });
  });

  it('uses the runtime event app id for run-scoped event queries', async () => {
    const repository = {
      findRuntimeEventAppIdForRun: vi.fn(async () => 'app-two'),
      findRunById: vi.fn(),
      findJobById: vi.fn(),
      listEvents: vi.fn(async () => []),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.listRecentJobEvents(25, { run_id: 'run-2' });

    expect(repository.findRuntimeEventAppIdForRun).toHaveBeenCalledWith(
      'run-2',
    );
    expect(repository.listEvents).toHaveBeenCalledWith(
      25,
      expect.objectContaining({
        appId: 'app-two',
        ownerAppId: undefined,
        runId: 'run-2',
      }),
    );
  });

  it('redacts provider session handles before persisting completed run summaries', async () => {
    const repository = {
      updateRunCompletion: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.completeJobRun(
      'run-1',
      'failed',
      'done provider-session:raw-token sessionId=inline-token {"newSessionId":"json-token"}',
      'boom claude-session-inline sessionId=error-token',
    );

    expect(repository.updateRunCompletion).toHaveBeenCalledTimes(1);
    const input = vi.mocked(repository.updateRunCompletion).mock.calls[0]?.[1];
    expect(input.resultSummary).toContain('[REDACTED]');
    expect(input.errorSummary).toContain('[REDACTED]');
    expect(input.resultSummary).not.toContain('provider-session:raw-token');
    expect(input.resultSummary).not.toContain('inline-token');
    expect(input.resultSummary).not.toContain('json-token');
    expect(input.errorSummary).not.toContain('claude-session-inline');
    expect(input.errorSummary).not.toContain('error-token');
  });

  it('rejects unsafe execution provider ids before inserting run history', async () => {
    const repository = {
      insertRun: vi.fn(async () => true),
      claimDueRunStart: vi.fn(async () => true),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await expect(
      service.createJobRun({
        run_id: 'run-1',
        job_id: 'job-1',
        execution_provider_id: '../bad-provider' as never,
        scheduled_for: '2026-04-24T00:00:00.000Z',
        started_at: '2026-04-24T00:00:00.000Z',
        ended_at: null,
        status: 'running',
        result_summary: null,
        error_summary: null,
        retry_count: 0,
        notified_at: null,
      }),
    ).rejects.toThrow(/Invalid execution provider id/);
    expect(repository.insertRun).not.toHaveBeenCalled();

    await expect(
      service.claimDueJobRunStart({
        jobId: 'job-1',
        runId: 'run-1',
        executionProviderId: '../bad-provider' as never,
        workerInstanceId: 'worker-test',
        scheduledFor: '2026-04-24T00:00:00.000Z',
        startedAt: '2026-04-24T00:00:00.000Z',
        retryCount: 0,
        leaseExpiresAt: '2026-04-24T00:05:00.000Z',
      }),
    ).rejects.toThrow(/Invalid execution provider id/);
    expect(repository.claimDueRunStart).not.toHaveBeenCalled();
  });

  it('passes app ownership filters to repository run and event queries', async () => {
    const repository = {
      listRuns: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.listJobRuns(undefined, 10, { ownerAppId: 'app-one' });
    await service.listRecentJobEvents(20, { owner_app_id: 'app-one' });

    expect(repository.listRuns).toHaveBeenCalledWith(undefined, 10, {
      ownerAppId: 'app-one',
    });
    expect(repository.listEvents).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        appId: undefined,
        ownerAppId: 'app-one',
      }),
    );
  });

  it('preserves approved notification routes beyond the execution context during writes', async () => {
    const repository = {
      findJobById: vi.fn(async () => null),
      upsertJob: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.upsertJob({
      id: 'job-1',
      name: 'Job',
      prompt: 'Run',
      schedule_type: 'interval',
      schedule_value: '60000',
      execution_context: {
        conversationJid: 'tg:team',
        threadId: null,
        workspaceKey: 'agent_one',
      },
      notification_routes: [
        {
          conversationJid: 'tg:team',
          threadId: null,
          label: 'Primary',
        },
        {
          conversationJid: 'tg:other',
          threadId: null,
          label: 'Linked',
        },
      ],
      workspace_key: '',
    });

    const stored = vi.mocked(repository.upsertJob).mock.calls[0]?.[0] as {
      targetJson: string;
    };
    const target = JSON.parse(stored.targetJson) as Record<string, unknown>;
    expect(target.notificationRoutes).toEqual([
      {
        conversationJid: 'tg:team',
        threadId: null,
        label: 'Primary',
      },
      {
        conversationJid: 'tg:other',
        threadId: null,
        label: 'Linked',
      },
    ]);
  });

  it('preserves approved stored notification routes beyond the execution context when loading jobs', async () => {
    const repository = {
      findJobById: vi.fn(async () => ({
        id: 'job-1',
        agentId: 'agent:agent_one',
        name: 'Job',
        prompt: 'Run',
        model: null,
        scheduleJson: JSON.stringify({ type: 'interval', value: '60000' }),
        status: 'active',
        targetJson: JSON.stringify({
          executionContext: {
            conversationJid: 'tg:team',
            threadId: null,
            workspaceKey: 'agent_one',
            sessionId: 'session-1',
          },
          notificationRoutes: [
            {
              conversationJid: 'tg:team',
              threadId: null,
              label: 'Primary',
            },
            {
              conversationJid: 'tg:other',
              threadId: null,
              label: 'Linked',
            },
          ],
        }),
        silent: false,
        timeoutMs: 300000,
        maxRetries: 3,
        retryBackoffMs: 5000,
        nextRunAt: null,
        lastRunAt: null,
        leaseRunId: null,
        leaseExpiresAt: null,
        createdAt: '2026-04-24T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      })),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await expect(service.getJobById('job-1')).resolves.toMatchObject({
      notification_routes: [
        {
          conversationJid: 'tg:team',
          threadId: null,
          label: 'Primary',
        },
        {
          conversationJid: 'tg:other',
          threadId: null,
          label: 'Linked',
        },
      ],
    });
  });

  it('persists capability requirements in canonical targetJson payloads', async () => {
    const repository = {
      findJobById: vi.fn(async () => null),
      upsertJob: vi.fn(async () => undefined),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await service.upsertJob({
      id: 'job-1',
      name: 'Job',
      prompt: 'Run',
      schedule_type: 'interval',
      schedule_value: '60000',
      execution_context: {
        conversationJid: 'tg:team',
        threadId: null,
        workspaceKey: 'agent_one',
        sessionId: 'session-1',
      },
      notification_routes: [
        {
          conversationJid: 'tg:team',
          threadId: null,
          label: 'Primary',
        },
      ],
      access_requirements: [
        { target: { kind: 'tool_rule', rule: 'Browser' } },
        { target: { kind: 'mcp_server', server: 'mcp:company-crm' } },
        {
          target: {
            kind: 'capability',
            capabilityId: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executablePath: '/usr/local/bin/acme',
              executableVersion: 'acme 1.2.3',
              executableHash: 'sha256:abc123',
              commandTemplate: '/usr/local/bin/acme records append *',
              authPreflight: '/usr/local/bin/acme auth status',
              protectedPaths: ['/tmp/creds'],
              networkHosts: ['api.acme.test'],
            },
          },
          reason: 'Write lead rows after each run',
        },
      ],
      workspace_key: '',
    });

    const stored = vi.mocked(repository.upsertJob).mock.calls[0]?.[0] as {
      targetJson: string;
    };
    const target = JSON.parse(stored.targetJson) as Record<string, unknown>;
    expect(target.accessRequirements).toEqual([
      { target: { kind: 'tool_rule', rule: 'Browser' } },
      { target: { kind: 'mcp_server', server: 'mcp:company-crm' } },
      {
        target: {
          kind: 'capability',
          capabilityId: 'acme.records.append',
          implementation: {
            kind: 'local_cli',
            name: 'acme',
            executablePath: '/usr/local/bin/acme',
            executableVersion: 'acme 1.2.3',
            executableHash: 'sha256:abc123',
            commandTemplate: '/usr/local/bin/acme records append *',
            authPreflight: '/usr/local/bin/acme auth status',
            protectedPaths: ['/tmp/creds'],
            networkHosts: ['api.acme.test'],
          },
        },
        reason: 'Write lead rows after each run',
      },
    ]);
  });

  it('reads capability requirements from canonical targetJson', async () => {
    const repository = {
      findJobById: vi.fn(async () => ({
        id: 'job-1',
        agentId: 'agent:agent_one',
        name: 'Job',
        prompt: 'Run',
        model: null,
        scheduleJson: JSON.stringify({ type: 'interval', value: '60000' }),
        status: 'active',
        targetJson: JSON.stringify({
          executionContext: {
            conversationJid: 'tg:team',
            threadId: null,
            workspaceKey: 'agent_one',
            sessionId: 'session-1',
          },
          notificationRoutes: [
            {
              conversationJid: 'tg:team',
              threadId: null,
              label: 'Primary',
            },
          ],
          accessRequirements: [
            { target: { kind: 'tool_rule', rule: 'Browser' } },
            { target: { kind: 'mcp_server', server: 'mcp:company-crm' } },
            {
              target: {
                kind: 'capability',
                capabilityId: 'acme.records.append',
                implementation: {
                  kind: 'local_cli',
                  name: 'acme',
                  executablePath: '/usr/local/bin/acme',
                  executableVersion: 'acme 1.2.3',
                  executableHash: 'sha256:abc123',
                  commandTemplate: '/usr/local/bin/acme records append *',
                  authPreflight: '/usr/local/bin/acme auth status',
                  protectedPaths: ['/tmp/creds'],
                  networkHosts: ['api.acme.test'],
                },
              },
              reason: 'Write lead rows after each run',
            },
          ],
        }),
        silent: false,
        timeoutMs: 300000,
        maxRetries: 3,
        retryBackoffMs: 5000,
        nextRunAt: null,
        lastRunAt: null,
        leaseRunId: null,
        leaseExpiresAt: null,
        createdAt: '2026-04-24T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      })),
    } as unknown as PostgresCanonicalJobRepository;
    const service = new CanonicalJobOpsService(repository);

    await expect(service.getJobById('job-1')).resolves.toMatchObject({
      access_requirements: [
        { target: { kind: 'tool_rule', rule: 'Browser' } },
        { target: { kind: 'mcp_server', server: 'mcp:company-crm' } },
        {
          target: {
            kind: 'capability',
            capabilityId: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executablePath: '/usr/local/bin/acme',
              executableVersion: 'acme 1.2.3',
              executableHash: 'sha256:abc123',
              commandTemplate: '/usr/local/bin/acme records append *',
              authPreflight: '/usr/local/bin/acme auth status',
              protectedPaths: ['/tmp/creds'],
              networkHosts: ['api.acme.test'],
            },
          },
          reason: 'Write lead rows after each run',
        },
      ],
    });
  });
});
