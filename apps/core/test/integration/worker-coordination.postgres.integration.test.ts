import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import { nowIso, nowMs, toIso } from '@core/shared/time/datetime.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function leaseFence(lease: {
  leaseToken: string;
  workerInstanceId: string;
  fencingVersion: number;
}) {
  return {
    leaseToken: lease.leaseToken,
    workerInstanceId: lease.workerInstanceId,
    fencingVersion: lease.fencingVersion,
  };
}

function makeJob(id: string, patch: Partial<JobUpsertInput> = {}) {
  const now = nowIso();
  return {
    id,
    name: `Job ${id}`,
    prompt: 'Summarize current status',
    schedule_type: 'manual',
    schedule_value: '',
    status: 'active',
    session_id: null,
    thread_id: null,
    execution_context: {
      conversationJid: 'tg:worker-coordination',
      threadId: null,
      workspaceKey: 'scheduler_agent',
      sessionId: null,
    },
    workspace_key: 'scheduler_agent',
    created_by: 'human',
    created_at: now,
    updated_at: now,
    next_run: null,
    silent: true,
    timeout_ms: 30_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    ...patch,
  } satisfies JobUpsertInput;
}

maybeDescribe('multi-worker coordination acceptance gates', () => {
  let runtime: PostgresIntegrationRuntime;
  let coordination: PostgresIntegrationRuntime['repositories']['workerCoordination'];

  const createRunForJob = async (jobId: string, runId: string) => {
    const created = await runtime.ops.createJobRun({
      run_id: runId,
      job_id: jobId,
      execution_provider_id: 'anthropic:claude-agent-sdk',
      scheduled_for: nowIso(),
      started_at: nowIso(),
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    expect(created).toBe(true);
  };

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'worker_coord',
    });
    coordination = runtime.repositories.workerCoordination;
    await coordination.registerWorker({ id: 'w1', bootNonce: 'nonce-w1' });
    await coordination.registerWorker({ id: 'w2', bootNonce: 'nonce-w2' });
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('two workers cannot run the same job', async () => {
    await runtime.ops.upsertJob(makeJob('job-exclusive'));
    const first = await runtime.ops.claimDueJobRunStart({
      jobId: 'job-exclusive',
      runId: 'run-exclusive-1',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId: 'w1',
      scheduledFor: nowIso(),
      startedAt: nowIso(),
      retryCount: 0,
      leaseExpiresAt: toIso(nowMs() + 60_000),
      requireNextRun: false,
    });
    expect(first).not.toBeNull();
    expect(first?.fencingVersion).toBe(1);
    expect(first?.workerInstanceId).toBe('w1');

    const second = await runtime.ops.claimDueJobRunStart({
      jobId: 'job-exclusive',
      runId: 'run-exclusive-2',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId: 'w2',
      scheduledFor: nowIso(),
      startedAt: nowIso(),
      retryCount: 0,
      leaseExpiresAt: toIso(nowMs() + 60_000),
      requireNextRun: false,
    });
    expect(second).toBeNull();

    // Direct lease-level double claim on the same run is also refused.
    const directSteal = await coordination.claimRunLease({
      runId: 'run-exclusive-1',
      jobId: 'job-exclusive',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    expect(directSteal).toBeNull();
  });

  it('a stale worker cannot complete a recovered run', async () => {
    await runtime.ops.upsertJob(makeJob('job-fencing'));
    await createRunForJob('job-fencing', 'run-fencing');
    // w1's lease lapses (claimed in the past with a short TTL).
    const staleLease = await coordination.claimRunLease({
      runId: 'run-fencing',
      jobId: 'job-fencing',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    expect(staleLease).not.toBeNull();

    // w2 recovers the run with a strictly higher fencing version.
    const recoveredLease = await coordination.claimRunLease({
      runId: 'run-fencing',
      jobId: 'job-fencing',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    expect(recoveredLease).not.toBeNull();
    expect(recoveredLease!.fencingVersion).toBeGreaterThan(
      staleLease!.fencingVersion,
    );
    expect(recoveredLease!.recoveredFromExpiredLease).toBe(true);

    // The stale worker's token no longer settles or writes terminal state.
    await expect(
      runtime.ops.settleJobRunLease({
        runId: 'run-fencing',
        leaseToken: staleLease!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.ops.settleJobRunLease({
        runId: 'run-fencing',
        leaseToken: recoveredLease!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('an expired active lease cannot settle before recovery sweeps it', async () => {
    await runtime.ops.upsertJob(makeJob('job-expired-settle'));
    await createRunForJob('job-expired-settle', 'run-expired-settle');
    const expiredLease = await coordination.claimRunLease({
      runId: 'run-expired-settle',
      jobId: 'job-expired-settle',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    expect(expiredLease).not.toBeNull();

    await expect(
      runtime.ops.settleJobRunLease({
        runId: 'run-expired-settle',
        leaseToken: expiredLease!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.ops.completeJobRunWithLease!({
        runId: 'run-expired-settle',
        leaseToken: expiredLease!.leaseToken,
        workerInstanceId: expiredLease!.workerInstanceId,
        fencingVersion: expiredLease!.fencingVersion,
        status: 'completed',
        resultSummary: 'late completion',
      }),
    ).resolves.toBe(false);
  });

  it('fenced completion writes only while the run lease is active', async () => {
    await runtime.ops.upsertJob(makeJob('job-fenced-completion'));
    await createRunForJob('job-fenced-completion', 'run-fenced-completion');
    const lease = await coordination.claimRunLease({
      runId: 'run-fenced-completion',
      jobId: 'job-fenced-completion',
      workerInstanceId: 'w1',
      ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();

    await expect(
      runtime.ops.completeJobRunWithLease!({
        runId: 'run-fenced-completion',
        leaseToken: lease!.leaseToken,
        workerInstanceId: lease!.workerInstanceId,
        fencingVersion: lease!.fencingVersion,
        status: 'completed',
        resultSummary: 'done',
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.ops.getJobRunById('run-fenced-completion'),
    ).resolves.toMatchObject({
      status: 'completed',
      result_summary: 'done',
    });
  });

  it('a deepagents-engine scheduled run claims the lease before execution and fences terminal writes', async () => {
    // Jobs inherit the bound agent's engine; the run persists the diagnostic
    // executionProviderId for that engine. The lease/fence machinery is
    // provider-neutral, so a deepagents:langchain run claims and fences exactly
    // like the anthropic lane — this guards that parity and that job run detail
    // derives the inherited engine read-only from the provider id.
    await runtime.ops.upsertJob(makeJob('job-deepagents-engine'));
    const claim = await runtime.ops.claimDueJobRunStart({
      jobId: 'job-deepagents-engine',
      runId: 'run-deepagents-engine',
      executionProviderId: 'deepagents:langchain' as never,
      workerInstanceId: 'w1',
      scheduledFor: nowIso(),
      startedAt: nowIso(),
      retryCount: 0,
      leaseExpiresAt: toIso(nowMs() + 60_000),
      requireNextRun: false,
    });
    // Worker may not execute without a confirmed claim.
    expect(claim).not.toBeNull();
    expect(claim?.workerInstanceId).toBe('w1');

    // A second worker cannot claim the same run (execution gated on the claim).
    const contender = await coordination.claimRunLease({
      runId: 'run-deepagents-engine',
      jobId: 'job-deepagents-engine',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    expect(contender).toBeNull();

    // The persisted run exposes the inherited engine (derived) + diagnostic id.
    await expect(
      runtime.ops.getJobRunById('run-deepagents-engine'),
    ).resolves.toMatchObject({
      execution_provider_id: 'deepagents:langchain',
      agent_engine: 'deepagents',
    });

    // Terminal writes are token-fenced: a stale/foreign token is dropped, the
    // confirmed lease token settles.
    await expect(
      runtime.ops.settleJobRunLease({
        runId: 'run-deepagents-engine',
        leaseToken: 'stale-token',
        outcome: 'completed',
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.ops.completeJobRunWithLease!({
        runId: 'run-deepagents-engine',
        leaseToken: claim!.leaseToken,
        workerInstanceId: claim!.workerInstanceId,
        fencingVersion: claim!.fencingVersion,
        status: 'completed',
        resultSummary: 'deepagents run done',
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.ops.getJobRunById('run-deepagents-engine'),
    ).resolves.toMatchObject({
      status: 'completed',
      result_summary: 'deepagents run done',
      agent_engine: 'deepagents',
    });
  });

  it('run-only terminal finalization writes and settles in one lease-fenced step', async () => {
    await runtime.ops.upsertJob(makeJob('job-run-only-finalization'));
    await createRunForJob(
      'job-run-only-finalization',
      'run-run-only-finalization',
    );
    const lease = await coordination.claimRunLease({
      runId: 'run-run-only-finalization',
      jobId: 'job-run-only-finalization',
      workerInstanceId: 'w1',
      ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();

    await expect(
      runtime.ops.finalizeJobRunLease!({
        runId: 'run-run-only-finalization',
        leaseToken: lease!.leaseToken,
        workerInstanceId: lease!.workerInstanceId,
        fencingVersion: lease!.fencingVersion,
        leaseOutcome: 'failed',
        runStatus: 'failed',
        errorSummary: 'failsafe completion',
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.ops.getJobRunById('run-run-only-finalization'),
    ).resolves.toMatchObject({
      status: 'failed',
      error_summary: 'failsafe completion',
    });
    await expect(
      runtime.ops.settleJobRunLease({
        runId: 'run-run-only-finalization',
        leaseToken: lease!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toBe(false);
  });

  it('terminal finalization preserves concurrent job edits outside terminal fields', async () => {
    await runtime.ops.upsertJob(makeJob('job-finalize-preserve'));
    const lease = await runtime.ops.claimDueJobRunStart({
      jobId: 'job-finalize-preserve',
      runId: 'run-finalize-preserve',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId: 'w1',
      scheduledFor: nowIso(),
      startedAt: nowIso(),
      retryCount: 0,
      leaseExpiresAt: toIso(nowMs() + 60_000),
      requireNextRun: false,
    });
    expect(lease).not.toBeNull();

    await runtime.service.pool.query(
      `UPDATE "${runtime.schemaName}".jobs SET name = $1 WHERE id = $2`,
      ['Renamed while running', 'job-finalize-preserve'],
    );
    await expect(
      runtime.ops.finalizeJobRunWithLease!({
        jobId: 'job-finalize-preserve',
        runId: 'run-finalize-preserve',
        leaseToken: lease!.leaseToken,
        workerInstanceId: lease!.workerInstanceId,
        fencingVersion: lease!.fencingVersion,
        leaseOutcome: 'completed',
        runStatus: 'completed',
        resultSummary: 'done',
        jobUpdates: {
          status: 'completed',
          next_run: null,
          last_run: nowIso(),
          consecutive_failures: 0,
          pause_reason: null,
          lease_run_id: null,
          lease_expires_at: null,
        },
      }),
    ).resolves.toBe(true);

    await expect(
      runtime.ops.getJobById('job-finalize-preserve'),
    ).resolves.toMatchObject({
      name: 'Renamed while running',
      status: 'completed',
      consecutive_failures: 0,
      pause_reason: null,
    });
  });

  it('notification evidence is fenced by the terminal run lease', async () => {
    await runtime.ops.upsertJob(makeJob('job-notification-fence'));
    await createRunForJob('job-notification-fence', 'run-notification-fence');
    const staleLease = await coordination.claimRunLease({
      runId: 'run-notification-fence',
      jobId: 'job-notification-fence',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    expect(staleLease).not.toBeNull();
    const recoveredLease = await coordination.claimRunLease({
      runId: 'run-notification-fence',
      jobId: 'job-notification-fence',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    expect(recoveredLease).not.toBeNull();

    await expect(
      runtime.ops.finalizeJobRunLease!({
        runId: 'run-notification-fence',
        leaseToken: recoveredLease!.leaseToken,
        workerInstanceId: recoveredLease!.workerInstanceId,
        fencingVersion: recoveredLease!.fencingVersion,
        leaseOutcome: 'completed',
        runStatus: 'completed',
        resultSummary: 'done',
      }),
    ).resolves.toBe(true);

    await expect(
      runtime.ops.markJobRunNotified(
        'run-notification-fence',
        leaseFence(staleLease!),
      ),
    ).resolves.toBe(false);
    await expect(
      runtime.ops.getJobRunById('run-notification-fence'),
    ).resolves.toMatchObject({ notified_at: null });
    await expect(
      runtime.ops.markJobRunNotified(
        'run-notification-fence',
        leaseFence(recoveredLease!),
      ),
    ).resolves.toBe(true);
    await expect(
      runtime.ops.getJobRunById('run-notification-fence'),
    ).resolves.toMatchObject({ notified_at: expect.any(String) });
  });

  it('provider metadata writes are fenced by the active run lease', async () => {
    await runtime.ops.upsertJob(makeJob('job-provider-metadata-fence'));
    await createRunForJob(
      'job-provider-metadata-fence',
      'run-provider-metadata-fence',
    );
    const staleLease = await coordination.claimRunLease({
      runId: 'run-provider-metadata-fence',
      jobId: 'job-provider-metadata-fence',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    expect(staleLease).not.toBeNull();
    const recoveredLease = await coordination.claimRunLease({
      runId: 'run-provider-metadata-fence',
      jobId: 'job-provider-metadata-fence',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    expect(recoveredLease).not.toBeNull();

    await expect(
      runtime.ops.updateAgentRunProviderMetadata!({
        runId: 'run-provider-metadata-fence',
        runIds: ['run-provider-metadata-fence'],
        ...leaseFence(staleLease!),
        providerRunId: 'provider-stale',
        providerSessionId: 'session-stale',
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.ops.getJobRunById('run-provider-metadata-fence'),
    ).resolves.toMatchObject({
      provider_run_id: null,
      provider_session_id: null,
    });

    await expect(
      runtime.ops.updateAgentRunProviderMetadata!({
        runId: 'run-provider-metadata-fence',
        runIds: ['run-provider-metadata-fence'],
        ...leaseFence(recoveredLease!),
        providerRunId: 'provider-recovered',
        providerSessionId: 'session-recovered',
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.ops.getJobRunById('run-provider-metadata-fence'),
    ).resolves.toMatchObject({
      provider_run_id: 'provider-recovered',
      provider_session_id: 'session-recovered',
    });
  });

  it('a worker crash releases only its expired leases', async () => {
    await runtime.ops.upsertJob(makeJob('job-crashed'));
    await runtime.ops.upsertJob(makeJob('job-live'));
    await createRunForJob('job-crashed', 'run-crashed');
    await createRunForJob('job-live', 'run-live');
    const crashedLease = await coordination.claimRunLease({
      runId: 'run-crashed',
      jobId: 'job-crashed',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    const liveLease = await coordination.claimRunLease({
      runId: 'run-live',
      jobId: 'job-live',
      workerInstanceId: 'w1',
      ttlMs: 120_000,
    });
    expect(crashedLease).not.toBeNull();
    expect(liveLease).not.toBeNull();

    const recovered = await coordination.recoverExpiredRunLeases({});
    const recoveredRunIds = recovered.map((lease) => lease.runId);
    expect(recoveredRunIds).toContain('run-crashed');
    expect(recoveredRunIds).not.toContain('run-live');

    await expect(
      coordination.getActiveRunLease({ runId: 'run-live' }),
    ).resolves.toMatchObject({ leaseToken: liveLease!.leaseToken });
    await expect(
      coordination.getActiveRunLease({ runId: 'run-crashed' }),
    ).resolves.toBeNull();
  });

  it('marks retry claims recovered after maintenance expired the old lease', async () => {
    await runtime.ops.upsertJob(makeJob('job-maintenance-recovered'));
    await createRunForJob(
      'job-maintenance-recovered',
      'run-maintenance-recovered',
    );
    const expiredLease = await coordination.claimRunLease({
      runId: 'run-maintenance-recovered',
      jobId: 'job-maintenance-recovered',
      workerInstanceId: 'w1',
      ttlMs: 1_000,
      now: toIso(nowMs() - 60_000),
    });
    expect(expiredLease).not.toBeNull();

    await expect(coordination.recoverExpiredRunLeases({})).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-maintenance-recovered' }),
      ]),
    );
    await createRunForJob(
      'job-maintenance-recovered',
      'run-maintenance-recovered-retry',
    );
    const retryLease = await coordination.claimRunLease({
      runId: 'run-maintenance-recovered-retry',
      jobId: 'job-maintenance-recovered',
      workerInstanceId: 'w2',
      ttlMs: 60_000,
    });
    expect(retryLease).toMatchObject({
      fencingVersion: expiredLease!.fencingVersion + 1,
      recoveredFromExpiredLease: true,
    });
  });

  it('reclaims an existing run row after maintenance recovery', async () => {
    await runtime.ops.upsertJob(makeJob('job-claim-recovered'));
    const staleStartedAt = toIso(nowMs() - 60_000);
    const staleLease = await runtime.ops.claimDueJobRunStart({
      jobId: 'job-claim-recovered',
      runId: 'run-claim-recovered',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId: 'w1',
      workerId: 'worker-folder-1',
      scheduledFor: staleStartedAt,
      startedAt: staleStartedAt,
      retryCount: 0,
      leaseExpiresAt: toIso(nowMs() - 30_000),
      requireNextRun: false,
    });
    expect(staleLease).not.toBeNull();

    await expect(coordination.recoverExpiredRunLeases({})).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-claim-recovered' }),
      ]),
    );
    await runtime.ops.releaseStaleJobLeases();
    const retryLease = await runtime.ops.claimDueJobRunStart({
      jobId: 'job-claim-recovered',
      runId: 'run-claim-recovered',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId: 'w2',
      workerId: 'worker-folder-2',
      scheduledFor: nowIso(),
      startedAt: nowIso(),
      retryCount: 0,
      leaseExpiresAt: toIso(nowMs() + 60_000),
      requireNextRun: false,
    });

    expect(retryLease).toMatchObject({
      fencingVersion: staleLease!.fencingVersion + 1,
      recoveredFromExpiredLease: true,
    });
    await expect(
      runtime.ops.getJobRunById('run-claim-recovered'),
    ).resolves.toMatchObject({
      status: 'running',
      worker_id: 'worker-folder-2',
      notified_at: null,
    });
    await expect(
      runtime.ops.finalizeJobRunWithLease!({
        jobId: 'job-claim-recovered',
        runId: 'run-claim-recovered',
        leaseToken: retryLease!.leaseToken,
        workerInstanceId: retryLease!.workerInstanceId,
        fencingVersion: retryLease!.fencingVersion,
        leaseOutcome: 'completed',
        runStatus: 'completed',
        resultSummary: 'recovered done',
        jobUpdates: {
          status: 'active',
          next_run: null,
          last_run: nowIso(),
          consecutive_failures: 0,
          pause_reason: null,
          lease_run_id: null,
          lease_expires_at: null,
        },
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.ops.claimDueJobRunStart({
        jobId: 'job-claim-recovered',
        runId: 'run-claim-recovered',
        executionProviderId: 'anthropic:claude-agent-sdk' as never,
        workerInstanceId: 'w3',
        scheduledFor: nowIso(),
        startedAt: nowIso(),
        retryCount: 0,
        leaseExpiresAt: toIso(nowMs() + 60_000),
        requireNextRun: false,
      }),
    ).resolves.toBeNull();
  });

  it('does not reclaim an existing terminal run row', async () => {
    await runtime.ops.upsertJob(makeJob('job-terminal-replay'));
    const lease = await runtime.ops.claimDueJobRunStart({
      jobId: 'job-terminal-replay',
      runId: 'run-terminal-replay',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId: 'w1',
      scheduledFor: nowIso(),
      startedAt: nowIso(),
      retryCount: 0,
      leaseExpiresAt: toIso(nowMs() + 60_000),
      requireNextRun: false,
    });
    expect(lease).not.toBeNull();
    await expect(
      runtime.ops.finalizeJobRunWithLease!({
        jobId: 'job-terminal-replay',
        runId: 'run-terminal-replay',
        leaseToken: lease!.leaseToken,
        workerInstanceId: lease!.workerInstanceId,
        fencingVersion: lease!.fencingVersion,
        leaseOutcome: 'completed',
        runStatus: 'completed',
        resultSummary: 'done',
        jobUpdates: {
          status: 'active',
          next_run: null,
          last_run: nowIso(),
          consecutive_failures: 0,
          pause_reason: null,
          lease_run_id: null,
          lease_expires_at: null,
        },
      }),
    ).resolves.toBe(true);

    await expect(
      runtime.ops.claimDueJobRunStart({
        jobId: 'job-terminal-replay',
        runId: 'run-terminal-replay',
        executionProviderId: 'anthropic:claude-agent-sdk' as never,
        workerInstanceId: 'w2',
        scheduledFor: nowIso(),
        startedAt: nowIso(),
        retryCount: 0,
        leaseExpiresAt: toIso(nowMs() + 60_000),
        requireNextRun: false,
      }),
    ).resolves.toBeNull();
  });

  it('permission prompts survive provider/control-plane restart', async () => {
    const created = await coordination.createPendingInteraction({
      id: 'interaction-1',
      appId: 'default',
      kind: 'permission',
      payload: { toolName: 'Bash', commandPreview: 'ls' },
      callbackRoute: { targetJid: 'tg:worker-coordination' },
      idempotencyKey: 'permission:scheduler_agent:req-1',
      expiresAt: toIso(nowMs() + 60_000),
    });
    expect(created.status).toBe('pending');

    // Restart-driven re-prompt reuses the same durable record.
    const reprompted = await coordination.createPendingInteraction({
      id: 'interaction-1-duplicate',
      appId: 'default',
      kind: 'permission',
      payload: { toolName: 'Bash', commandPreview: 'ls' },
      idempotencyKey: 'permission:scheduler_agent:req-1',
      expiresAt: toIso(nowMs() + 60_000),
    });
    expect(reprompted.id).toBe('interaction-1');
    // The re-prompt omitted callbackRoute; the durable record must KEEP the
    // route the original prompt recorded (COALESCE), or interaction resolution
    // can no longer reach the owning live turn after a restart + takeover.
    expect(reprompted.callbackRoute).toEqual({
      targetJid: 'tg:worker-coordination',
    });

    const pending = await coordination.listPendingInteractions({
      appId: 'default',
    });
    expect(pending.map((row) => row.id)).toContain('interaction-1');
    expect(
      pending.find((row) => row.id === 'interaction-1')?.callbackRoute,
    ).toEqual({ targetJid: 'tg:worker-coordination' });

    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: 'permission:scheduler_agent:req-1',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
      }),
    ).resolves.toBe(true);
    // Idempotent: a second resolution callback is a no-op.
    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: 'permission:scheduler_agent:req-1',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
      }),
    ).resolves.toBe(false);
    const pendingAfter = await coordination.listPendingInteractions({
      appId: 'default',
    });
    expect(pendingAfter.map((row) => row.id)).not.toContain('interaction-1');
  });

  it('replayed runner-control events are rejected', async () => {
    await runtime.ops.upsertJob(makeJob('job-events'));
    await createRunForJob('job-events', 'run-events');
    const lease = await coordination.claimRunLease({
      runId: 'run-events',
      jobId: 'job-events',
      workerInstanceId: 'w1',
      ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();

    await expect(
      coordination.appendRunnerControlEvent({
        id: 'event-1',
        runId: 'run-events',
        leaseToken: lease!.leaseToken,
        eventType: 'output',
        payload: { chars: 12 },
        nonce: 'nonce-event-1',
      }),
    ).resolves.toBe('persisted');
    await expect(
      coordination.appendRunnerControlEvent({
        id: 'event-1-replay',
        runId: 'run-events',
        leaseToken: lease!.leaseToken,
        eventType: 'output',
        payload: { chars: 12 },
        nonce: 'nonce-event-1',
      }),
    ).resolves.toBe('replayed');
    await expect(
      coordination.appendRunnerControlEvent({
        id: 'event-2',
        runId: 'run-events',
        leaseToken: 'not-the-active-lease-token',
        eventType: 'output',
        nonce: 'nonce-event-2',
      }),
    ).resolves.toBe('fenced');

    // Persist-before-expose: the event is durable first, exposed second.
    const unexposed = await coordination.listUnexposedRunnerControlEvents({
      limit: 10,
    });
    expect(unexposed.map((event) => event.id)).toContain('event-1');
    await coordination.markRunnerControlEventsExposed({ ids: ['event-1'] });
    const afterExpose = await coordination.listUnexposedRunnerControlEvents({
      limit: 10,
    });
    expect(afterExpose.map((event) => event.id)).not.toContain('event-1');

    await expect(
      coordination.settleRunLease({
        runId: 'run-events',
        leaseToken: lease!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toBe(true);
    await expect(
      coordination.appendRunnerControlEvent({
        id: 'event-terminal',
        runId: 'run-events',
        leaseToken: lease!.leaseToken,
        eventType: 'terminal_state',
        payload: { outcome: 'completed' },
        nonce: 'nonce-event-terminal',
      }),
    ).resolves.toBe('persisted');
  });

  it('transient grants are run-scoped and die with the lease', async () => {
    await runtime.ops.upsertJob(makeJob('job-grants'));
    await createRunForJob('job-grants', 'run-grants');
    const lease = await coordination.claimRunLease({
      runId: 'run-grants',
      jobId: 'job-grants',
      workerInstanceId: 'w1',
      ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();

    await expect(
      coordination.createTransientGrant({
        id: 'grant-1',
        appId: 'default',
        runId: 'run-grants',
        leaseToken: lease!.leaseToken,
        grant: { toolName: 'WebFetch', mode: 'allow_once' },
        expiresAt: toIso(nowMs() + 60_000),
      }),
    ).resolves.toBe(true);
    // A grant minted against a token that is not the active lease is refused.
    await expect(
      coordination.createTransientGrant({
        id: 'grant-2',
        appId: 'default',
        runId: 'run-grants',
        leaseToken: 'stale-token',
        grant: { toolName: 'Bash', mode: 'allow_once' },
        expiresAt: toIso(nowMs() + 60_000),
      }),
    ).resolves.toBe(false);

    const active = await coordination.listActiveTransientGrants({
      runId: 'run-grants',
    });
    expect(active.map((grant) => grant.id)).toEqual(['grant-1']);

    // Once the lease ends, the grant confers nothing: unselected/expired
    // authority is unavailable to any later run of the same job.
    await coordination.settleRunLease({
      runId: 'run-grants',
      leaseToken: lease!.leaseToken,
      outcome: 'completed',
    });
    await expect(
      coordination.listActiveTransientGrants({ runId: 'run-grants' }),
    ).resolves.toEqual([]);
  });

  it('cluster run slots bound concurrency and reclaim expired holders', async () => {
    await expect(
      coordination.acquireRunSlot({
        slotKey: 'workspace:scheduler_agent',
        holderId: 'holder-a',
        capacity: 1,
        ttlMs: 60_000,
      }),
    ).resolves.toBe(true);
    await expect(
      coordination.acquireRunSlot({
        slotKey: 'workspace:scheduler_agent',
        holderId: 'holder-b',
        capacity: 1,
        ttlMs: 60_000,
      }),
    ).resolves.toBe(false);
    await coordination.releaseRunSlot({
      slotKey: 'workspace:scheduler_agent',
      holderId: 'holder-a',
    });
    await expect(
      coordination.acquireRunSlot({
        slotKey: 'workspace:scheduler_agent',
        holderId: 'holder-b',
        capacity: 1,
        ttlMs: 60_000,
      }),
    ).resolves.toBe(true);

    // A crashed holder's expired slot is reclaimable by any worker.
    await expect(
      coordination.acquireRunSlot({
        slotKey: 'workspace:crashed',
        holderId: 'holder-crashed',
        capacity: 1,
        ttlMs: 1_000,
        now: toIso(nowMs() - 60_000),
      }),
    ).resolves.toBe(true);
    await expect(
      coordination.acquireRunSlot({
        slotKey: 'workspace:crashed',
        holderId: 'holder-new',
        capacity: 1,
        ttlMs: 60_000,
      }),
    ).resolves.toBe(true);
  });

  it('round-trips the process role and defaults it to "all"', async () => {
    await coordination.registerWorker({
      id: 'w-role-default',
      bootNonce: 'nonce-role-default',
    });
    await coordination.registerWorker({
      id: 'w-role-job',
      bootNonce: 'nonce-role-job',
      processRole: 'job-worker',
    });

    const defaulted = await coordination.getWorker('w-role-default');
    const jobWorker = await coordination.getWorker('w-role-job');
    expect(defaulted?.processRole).toBe('all');
    expect(jobWorker?.processRole).toBe('job-worker');

    const listed = await coordination.listWorkers();
    expect(listed.find((w) => w.id === 'w-role-job')?.processRole).toBe(
      'job-worker',
    );
  });

  it('worker heartbeats gate health; lapsed workers go unhealthy', async () => {
    await coordination.registerWorker({ id: 'w-stale', bootNonce: 'nonce' });
    // Backdate the heartbeat by registering and then sweeping with a future
    // stale threshold.
    const unhealthy = await coordination.markStaleWorkersUnhealthy({
      staleBefore: toIso(nowMs() + 60_000),
    });
    expect(unhealthy).toContain('w-stale');
    await expect(coordination.heartbeatWorker({ id: 'w-stale' })).resolves.toBe(
      true,
    );
    const worker = await coordination.getWorker('w-stale');
    expect(worker?.status).toBe('healthy');
  });
});
