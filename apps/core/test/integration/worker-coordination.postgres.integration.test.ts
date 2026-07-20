import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  bindPendingPermissionInteractionMessage,
  claimPermissionInteractionCallback,
  configurePendingInteractionDurability,
  findDurablePermissionInteractionByRequestId,
  releasePermissionInteractionCallback,
  replayPersistedPermissionDecisionForRequest,
} from '@core/application/interactions/pending-interaction-durability.js';
import type { JobUpsertInput } from '@core/domain/repositories/ops-repo.js';
import type { PermissionCallbackClaim } from '@core/domain/types.js';
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

  const permissionIdempotencyKey = (
    sourceAgentFolder: string,
    requestId: string,
  ) => `default:permission:${sourceAgentFolder}:${requestId}`;

  const createPermissionMember = async (input: {
    requestId: string;
    sourceAgentFolder?: string;
    expiresAt?: string;
    payload?: Record<string, unknown>;
  }) => {
    const sourceAgentFolder = input.sourceAgentFolder ?? 'scheduler_agent';
    return coordination.createPendingInteraction({
      id: `interaction-${sourceAgentFolder}-${input.requestId}`,
      appId: 'default',
      sourceAgentFolder,
      requestId: input.requestId,
      kind: 'permission',
      payload: {
        request: {
          requestId: input.requestId,
          sourceAgentFolder,
          targetJid: 'tg:worker-coordination',
          toolName: 'Bash',
        },
        ...input.payload,
      },
      idempotencyKey: permissionIdempotencyKey(
        sourceAgentFolder,
        input.requestId,
      ),
      expiresAt: input.expiresAt ?? toIso(nowMs() + 60_000),
    });
  };

  const bindPermissionPrompt = async (input: {
    interactionId: string;
    requestIds: readonly string[];
    sourceAgentFolder?: string;
    providerAliases?: string[];
    mode?: 'individual' | 'batch';
    externalPromptProvider?: string;
    externalPromptConversationId?: string;
    externalPromptMessageId?: string;
    externalPromptThreadId?: string | null;
  }) => {
    const sourceAgentFolder = input.sourceAgentFolder ?? 'scheduler_agent';
    const matchKind =
      input.mode ?? (input.requestIds.length > 1 ? 'batch' : 'individual');
    return coordination.bindPendingPermissionPrompt({
      id: `prompt-${sourceAgentFolder}-${input.interactionId}`,
      appId: 'default',
      sourceAgentFolder,
      interactionId: input.interactionId,
      matchKind,
      members: input.requestIds.map((requestId, index) => ({
        idempotencyKey: permissionIdempotencyKey(sourceAgentFolder, requestId),
        requestId,
        index,
      })),
      envelope: {
        version: 1,
        renderedDecisionOptions: ['allow_once', 'cancel'],
        targetJid: 'tg:worker-coordination',
        approvalContextJid: 'tg:worker-coordination',
        threadId: null,
        decisionPolicy: null,
        renderedRequest: {
          requestId: input.interactionId,
          sourceAgentFolder,
          targetJid: 'tg:worker-coordination',
          toolName: 'Bash',
          ...(matchKind === 'batch'
            ? {
                permissionBatch: {
                  requestIds: [...input.requestIds],
                  rows: input.requestIds.map(
                    (_, index) => `${index + 1}. Bash`,
                  ),
                },
              }
            : {}),
        },
      },
      ...(input.externalPromptProvider
        ? {
            externalPromptProvider: input.externalPromptProvider,
            externalPromptConversationId: input.externalPromptConversationId!,
            externalPromptMessageId: input.externalPromptMessageId!,
            externalPromptThreadId: input.externalPromptThreadId ?? null,
          }
        : {}),
      providerAliases: input.providerAliases ?? [],
    });
  };

  const storedPermissionClaim = (claim: PermissionCallbackClaim) =>
    expect.objectContaining({
      id: claim.id,
      scope: claim.scope,
      intent: expect.objectContaining({
        mode: claim.intent.mode,
        approverRef: claim.intent.approverRef,
      }),
      match: expect.objectContaining({
        kind: claim.match.kind,
        canonicalId: claim.match.canonicalId,
        providerAliases: expect.arrayContaining(claim.match.providerAliases),
      }),
    });

  const expireSettledReviewEachBatch = async (key: string) => {
    const sourceAgentFolder = 'scheduler_agent';
    const batchId = `batch:expire-settled-recovery:${key}`;
    const requestIds = [
      `req-expire-settled-recovery-${key}-1`,
      `req-expire-settled-recovery-${key}-2`,
    ];
    const providerAlias = `opaque-expire-settled-recovery-${key}`;
    for (const requestId of requestIds) {
      await createPermissionMember({
        requestId,
        sourceAgentFolder,
      });
    }
    await bindPermissionPrompt({
      interactionId: batchId,
      requestIds,
      sourceAgentFolder,
      providerAliases: [providerAlias],
    });
    const scope = {
      appId: 'default',
      sourceAgentFolder,
      interactionId: batchId,
    };
    const claim = {
      id: `claim-expire-settled-recovery-${key}`,
      scope,
      intent: {
        mode: 'allow_persistent_rule',
        approverRef: 'user:approver',
        decidedAt: nowIso(),
      },
      match: {
        kind: 'batch',
        canonicalId: batchId,
        providerAliases: [providerAlias],
      },
    } satisfies PermissionCallbackClaim;
    const claimed = await coordination.claimPendingPermissionCallback({
      claim,
    });
    expect(claimed?.members).toHaveLength(2);
    expect(
      new Date(claimed!.prompt.claim!.intent.decidedAt).toISOString(),
    ).toBe(new Date(claim.intent.decidedAt).toISOString());
    await expect(
      coordination.settlePendingPermissionCallback({ claim }),
    ).resolves.toBe(true);
    const expired = await coordination.expirePendingPermissionReviewEach({
      claim,
      now: '2026-07-19T00:00:00.000Z',
    });
    expect(expired?.members).toHaveLength(2);
    return { providerAlias, scope };
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

  afterEach(() => {
    configurePendingInteractionDurability(null);
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

  it('a stale worker crash releases its active leases before the TTL lapses', async () => {
    await coordination.registerWorker({
      id: 'w-stale-active-lease',
      bootNonce: 'nonce-stale-active-lease',
      now: toIso(nowMs() - 120_000),
    });
    await runtime.ops.upsertJob(makeJob('job-stale-worker-lease'));
    await runtime.ops.upsertJob(makeJob('job-healthy-worker-lease'));
    await createRunForJob('job-stale-worker-lease', 'run-stale-worker-lease');
    await createRunForJob(
      'job-healthy-worker-lease',
      'run-healthy-worker-lease',
    );
    const staleWorkerLease = await coordination.claimRunLease({
      runId: 'run-stale-worker-lease',
      jobId: 'job-stale-worker-lease',
      workerInstanceId: 'w-stale-active-lease',
      ttlMs: 120_000,
    });
    const healthyWorkerLease = await coordination.claimRunLease({
      runId: 'run-healthy-worker-lease',
      jobId: 'job-healthy-worker-lease',
      workerInstanceId: 'w2',
      ttlMs: 120_000,
    });
    expect(staleWorkerLease).not.toBeNull();
    expect(healthyWorkerLease).not.toBeNull();

    const recovered = await coordination.recoverExpiredRunLeases({
      staleBefore: toIso(nowMs() - 60_000),
    });
    const recoveredRunIds = recovered.map((lease) => lease.runId);
    expect(recoveredRunIds).toContain('run-stale-worker-lease');
    expect(recoveredRunIds).not.toContain('run-healthy-worker-lease');
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

  it('releases a job lease after stale-worker recovery expires its run lease', async () => {
    await coordination.registerWorker({
      id: 'w-stale-job-lease',
      bootNonce: 'nonce-stale-job-lease',
      now: toIso(nowMs() - 120_000),
    });
    await runtime.ops.upsertJob(makeJob('job-stale-job-lease'));
    const runLease = await runtime.ops.claimDueJobRunStart({
      jobId: 'job-stale-job-lease',
      runId: 'run-stale-job-lease',
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId: 'w-stale-job-lease',
      workerId: 'worker-folder-1',
      scheduledFor: nowIso(),
      startedAt: nowIso(),
      retryCount: 0,
      leaseExpiresAt: toIso(nowMs() + 120_000),
      requireNextRun: false,
    });
    expect(runLease).not.toBeNull();

    await coordination.recoverExpiredRunLeases({
      staleBefore: toIso(nowMs() - 60_000),
    });
    const released = await runtime.ops.releaseStaleJobLeases();

    expect(released).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: 'job-stale-job-lease',
          runId: 'run-stale-job-lease',
          runTimedOut: true,
        }),
      ]),
    );
    await expect(
      runtime.ops.getJobById('job-stale-job-lease'),
    ).resolves.toMatchObject({
      status: 'active',
      lease_run_id: null,
      lease_expires_at: null,
    });
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
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'req-1',
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
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'req-1',
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
    // Idempotent: the same terminal permission resolution is successful.
    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: 'permission:scheduler_agent:req-1',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
      }),
    ).resolves.toBe(true);
    const pendingAfter = await coordination.listPendingInteractions({
      appId: 'default',
    });
    expect(pendingAfter.map((row) => row.id)).not.toContain('interaction-1');
  });

  it('reopens only cancelled questions and admits one concurrent re-ask', async () => {
    const cancelledKey =
      'test-default:question:scheduler_agent:req-question-reask';
    await coordination.createPendingInteraction({
      id: 'question-orphan',
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'req-question-reask',
      kind: 'question',
      payload: { question: 'Old payload' },
      idempotencyKey: cancelledKey,
      expiresAt: toIso(nowMs() + 60_000),
    });
    await coordination.resolvePendingInteraction({
      idempotencyKey: cancelledKey,
      status: 'cancelled',
      resolution: { answers: {}, reason: 'restart' },
    });

    const reopened = await coordination.createPendingInteraction({
      id: 'question-reopened',
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'req-question-reask',
      kind: 'question',
      payload: { question: 'Fresh payload' },
      idempotencyKey: cancelledKey,
      expiresAt: toIso(nowMs() + 120_000),
    });
    expect(reopened).toMatchObject({
      id: 'question-reopened',
      status: 'pending',
      payload: { question: 'Fresh payload' },
      resolution: null,
      resolvedAt: null,
    });
    const pendingCollision = await coordination.createPendingInteraction({
      id: 'question-while-pending',
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'req-question-reask',
      kind: 'question',
      payload: { question: 'Must not replace the pending winner' },
      idempotencyKey: cancelledKey,
      expiresAt: toIso(nowMs() + 180_000),
    });
    expect(pendingCollision).toMatchObject({
      id: 'question-reopened',
      status: 'pending',
      payload: { question: 'Fresh payload' },
    });

    await coordination.resolvePendingInteraction({
      idempotencyKey: cancelledKey,
      status: 'resolved',
      resolution: { answers: { question: 'Answered' } },
    });
    const answeredCollision = await coordination.createPendingInteraction({
      id: 'question-after-answer',
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'req-question-reask',
      kind: 'question',
      payload: { question: 'Must not replace the answer' },
      idempotencyKey: cancelledKey,
      expiresAt: toIso(nowMs() + 180_000),
    });
    expect(answeredCollision).toMatchObject({
      id: 'question-reopened',
      status: 'resolved',
      payload: { question: 'Fresh payload' },
      resolution: { answers: { question: 'Answered' } },
    });

    const concurrentKey =
      'test-default:question:scheduler_agent:req-question-concurrent';
    await coordination.createPendingInteraction({
      id: 'question-concurrent-orphan',
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'req-question-concurrent',
      kind: 'question',
      payload: { attempt: 'orphan' },
      idempotencyKey: concurrentKey,
      expiresAt: toIso(nowMs() + 60_000),
    });
    await coordination.resolvePendingInteraction({
      idempotencyKey: concurrentKey,
      status: 'cancelled',
      resolution: { answers: {}, reason: 'restart' },
    });
    const attempts = ['question-concurrent-a', 'question-concurrent-b'];
    const results = await Promise.all(
      attempts.map((id) =>
        coordination.createPendingInteraction({
          id,
          appId: 'default',
          sourceAgentFolder: 'scheduler_agent',
          requestId: 'req-question-concurrent',
          kind: 'question',
          payload: { attempt: id },
          idempotencyKey: concurrentKey,
          expiresAt: toIso(nowMs() + 120_000),
        }),
      ),
    );
    expect(new Set(results.map((row) => row.id))).toEqual(
      new Set([results[0]!.id]),
    );
    expect(attempts).toContain(results[0]!.id);
    expect(
      results.filter((row, index) => row.id === attempts[index]).length,
    ).toBe(1);
    expect(results).toEqual([
      expect.objectContaining({ status: 'pending' }),
      expect.objectContaining({ status: 'pending' }),
    ]);
  });

  it('fails closed on absent or malformed question lease state and permits one re-ask after a dead lease', async () => {
    const jobId = 'job-question-lease-state';
    await runtime.ops.upsertJob(makeJob(jobId));
    const malformedLeaseColumns = [
      {},
      { runLeaseToken: '', runLeaseFencingVersion: 1 },
      { runLeaseToken: 'lease-token', runLeaseFencingVersion: 0 },
    ];
    for (const [index, leaseColumns] of malformedLeaseColumns.entries()) {
      const id = `question-malformed-lease-${index}`;
      const runId = `run-malformed-lease-${index}`;
      await createRunForJob(jobId, runId);
      await coordination.createPendingInteraction({
        id,
        appId: 'default',
        runId,
        sourceAgentFolder: 'scheduler_agent',
        requestId: id,
        ...leaseColumns,
        kind: 'question',
        payload: {},
        idempotencyKey: `default:question:scheduler_agent:${id}`,
        expiresAt: toIso(nowMs() + 60_000),
      });
      await expect(
        coordination.cancelPendingQuestionInteractionIfRunLeaseInactive({
          id,
          resolution: { answers: {}, reason: 'restart' },
        }),
      ).resolves.toBe(false);
    }

    const idempotencyKey =
      'default:question:scheduler_agent:question-dead-lease';
    await createRunForJob(jobId, 'run-without-active-lease');
    await coordination.createPendingInteraction({
      id: 'question-dead-lease-old',
      appId: 'default',
      runId: 'run-without-active-lease',
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'question-dead-lease',
      runLeaseToken: 'dead-lease-token',
      runLeaseFencingVersion: 1,
      kind: 'question',
      payload: {},
      idempotencyKey,
      expiresAt: toIso(nowMs() + 60_000),
    });
    await expect(
      coordination.cancelPendingQuestionInteractionIfRunLeaseInactive({
        id: 'question-dead-lease-old',
        resolution: { answers: {}, reason: 'restart' },
      }),
    ).resolves.toBe(true);
    const retried = await coordination.createPendingInteraction({
      id: 'question-dead-lease-retry',
      appId: 'default',
      runId: 'run-without-active-lease',
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'question-dead-lease',
      runLeaseToken: 'new-lease-token',
      runLeaseFencingVersion: 2,
      kind: 'question',
      payload: {},
      idempotencyKey,
      expiresAt: toIso(nowMs() + 60_000),
    });
    expect(retried).toMatchObject({
      id: 'question-dead-lease-retry',
      status: 'pending',
    });
    const duplicateRetry = await coordination.createPendingInteraction({
      id: 'question-dead-lease-second-retry',
      appId: 'default',
      runId: 'run-without-active-lease',
      sourceAgentFolder: 'scheduler_agent',
      requestId: 'question-dead-lease',
      runLeaseToken: 'new-lease-token',
      runLeaseFencingVersion: 2,
      kind: 'question',
      payload: {},
      idempotencyKey,
      expiresAt: toIso(nowMs() + 60_000),
    });
    expect(duplicateRetry.id).toBe('question-dead-lease-retry');
  });

  it('restores a claimed batch alias on release and exposes persisted intent while claimed', async () => {
    const callbackId = 'batch:req-atomic-1:2';
    const providerCallbackId = 'opaque-batch-callback';
    const requestIds = ['req-atomic-1', 'req-atomic-2'] as const;
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      interactionId: callbackId,
    };
    const claim = {
      id: 'claim-batch-1',
      scope,
      intent: {
        mode: 'allow_once',
        approverRef: 'user:approver',
        decidedAt: nowIso(),
      },
      match: {
        kind: 'batch',
        canonicalId: callbackId,
        providerAliases: [providerCallbackId],
      },
    } satisfies PermissionCallbackClaim;
    for (const requestId of requestIds) {
      await createPermissionMember({ requestId });
    }
    await bindPermissionPrompt({
      interactionId: callbackId,
      requestIds,
      providerAliases: [providerCallbackId, 'other-row-alias'],
    });
    await createPermissionMember({ requestId: 'req-other-batch' });
    await bindPermissionPrompt({
      interactionId: 'batch:req-other-batch:1',
      requestIds: ['req-other-batch'],
      providerAliases: ['other-batch-alias'],
      mode: 'batch',
    });

    const claimed = await coordination.claimPendingPermissionCallback({
      claim,
    });
    expect(claimed).toMatchObject({
      prompt: {
        interactionId: callbackId,
        providerAliases: [providerCallbackId, 'other-row-alias'],
        claim: storedPermissionClaim(claim),
        settlementState: 'claimed',
      },
    });
    expect(claimed?.members).toHaveLength(2);
    await expect(
      coordination.findPendingPermissionPrompt({
        scope: {
          appId: 'default',
          sourceAgentFolder: 'scheduler_agent',
          interactionId: 'batch:req-other-batch:1',
        },
      }),
    ).resolves.toMatchObject({
      prompt: { settlementState: 'open' },
    });
    const otherBatch = await coordination.findPendingPermissionPrompt({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'scheduler_agent',
        interactionId: 'batch:req-other-batch:1',
      },
    });
    expect(otherBatch?.members).toHaveLength(1);
    await expect(
      coordination.claimPendingPermissionCallback({
        claim: {
          ...claim,
          id: 'claim-batch-loser',
          match: { ...claim.match, providerAliases: ['other-row-alias'] },
        },
      }),
    ).resolves.toBeNull();
    configurePendingInteractionDurability({ repository: coordination });
    const durable = await findDurablePermissionInteractionByRequestId({
      scope,
      providerAlias: providerCallbackId,
    });
    expect(durable).toMatchObject({
      scope,
      claim: {
        id: claim.id,
        intent: {
          mode: claim.intent.mode,
          approverRef: claim.intent.approverRef,
        },
        match: {
          kind: 'batch',
          canonicalId: callbackId,
        },
      },
      providerAliases: expect.arrayContaining([
        providerCallbackId,
        'other-row-alias',
      ]),
    });
    expect(new Date(durable!.claim!.intent.decidedAt).toISOString()).toBe(
      claim.intent.decidedAt,
    );
    await expect(
      claimPermissionInteractionCallback({
        scope,
        mode: 'allow_once',
        approverRef: 'user:approver',
        matchKind: 'batch',
      }),
    ).resolves.toEqual({ status: 'already_decided' });

    await expect(releasePermissionInteractionCallback({ claim })).resolves.toBe(
      true,
    );
    const released = await coordination.findPendingPermissionPrompt({
      scope,
    });
    expect(released).toMatchObject({
      prompt: {
        interactionId: callbackId,
        providerAliases: [providerCallbackId, 'other-row-alias'],
        claim: null,
        settlementState: 'open',
      },
    });
    expect(released?.members).toHaveLength(2);
    await expect(
      findDurablePermissionInteractionByRequestId({
        scope,
        providerAlias: providerCallbackId,
      }),
    ).resolves.toMatchObject({
      requestId: callbackId,
      batchCallbackId: callbackId,
    });

    const retriedClaim = await coordination.claimPendingPermissionCallback({
      claim: { ...claim, id: 'claim-batch-retry' },
    });
    expect(retriedClaim?.members).toHaveLength(2);
    await expect(
      claimPermissionInteractionCallback({
        scope,
        mode: 'allow_once',
        approverRef: 'user:approver',
        matchKind: 'batch',
      }),
    ).resolves.toEqual({ status: 'already_decided' });
  });

  it('rejects partial-overlap rebinding without stranding the omitted batch member', async () => {
    const sourceAgentFolder = 'scheduler_agent';
    const oldCallbackId = 'batch:req-rebound-a:2:old-request-set';
    const newCallbackId = 'batch:req-rebound-a:2:new-request-set';
    const oldRequestIds = ['req-rebound-a', 'req-rebound-b'];
    const newRequestIds = ['req-rebound-a', 'req-rebound-c'];
    for (const requestId of [...oldRequestIds, 'req-rebound-c']) {
      await createPermissionMember({ requestId, sourceAgentFolder });
    }
    await bindPermissionPrompt({
      interactionId: oldCallbackId,
      requestIds: oldRequestIds,
      sourceAgentFolder,
      providerAliases: ['old-provider-alias'],
    });
    await expect(
      bindPermissionPrompt({
        interactionId: newCallbackId,
        requestIds: newRequestIds,
        sourceAgentFolder,
        providerAliases: ['new-provider-alias'],
      }),
    ).resolves.toBeNull();

    const claim = (id: string, callbackId: string, providerAlias: string) =>
      ({
        id,
        scope: {
          appId: 'default',
          sourceAgentFolder,
          interactionId: callbackId,
        },
        intent: {
          mode: 'allow_once',
          approverRef: 'user:approver',
          decidedAt: nowIso(),
        },
        match: {
          kind: 'batch',
          canonicalId: callbackId,
          providerAliases: [providerAlias],
        },
      }) satisfies PermissionCallbackClaim;

    await expect(
      coordination.claimPendingPermissionCallback({
        claim: claim(
          'claim-old-rebound-batch',
          oldCallbackId,
          'old-provider-alias',
        ),
      }),
    ).resolves.toMatchObject({
      prompt: {
        interactionId: oldCallbackId,
        settlementState: 'claimed',
      },
      members: oldRequestIds.map((requestId) =>
        expect.objectContaining({ requestId }),
      ),
    });
    await expect(
      coordination.claimPendingPermissionCallback({
        claim: claim(
          'claim-new-rebound-batch',
          newCallbackId,
          'new-provider-alias',
        ),
      }),
    ).resolves.toBeNull();
    await expect(
      coordination.findPendingPermissionPrompt({
        scope: {
          appId: 'default',
          sourceAgentFolder,
          interactionId: oldCallbackId,
        },
        includeTerminalSettlement: true,
      }),
    ).resolves.toMatchObject({
      prompt: {
        interactionId: oldCallbackId,
        settlementState: 'claimed',
      },
      members: oldRequestIds.map((requestId) =>
        expect.objectContaining({ requestId }),
      ),
    });
  });

  it('admits exactly one concurrent batch claim and rejects missing, stale, or expired members', async () => {
    const sourceAgentFolder = 'scheduler_agent';
    const createBatchMember = async (input: {
      requestId: string;
      expiresAt: string;
    }) =>
      createPermissionMember({
        requestId: input.requestId,
        sourceAgentFolder,
        expiresAt: input.expiresAt,
      });
    const batchClaim = (input: {
      id: string;
      batchId: string;
      providerAlias: string;
      decidedAt?: string;
    }) =>
      ({
        id: input.id,
        scope: {
          appId: 'default',
          sourceAgentFolder,
          interactionId: input.batchId,
        },
        intent: {
          mode: 'allow_once' as const,
          approverRef: 'user:approver',
          decidedAt: input.decidedAt ?? nowIso(),
        },
        match: {
          kind: 'batch' as const,
          canonicalId: input.batchId,
          providerAliases: [input.providerAlias],
        },
      }) satisfies PermissionCallbackClaim;

    const concurrentBatchId = 'batch:concurrent:2';
    const concurrentRequestIds = ['req-concurrent-1', 'req-concurrent-2'];
    for (const requestId of concurrentRequestIds) {
      await createBatchMember({
        requestId,
        expiresAt: toIso(nowMs() + 60_000),
      });
    }
    await bindPermissionPrompt({
      interactionId: concurrentBatchId,
      requestIds: concurrentRequestIds,
      sourceAgentFolder,
      providerAliases: concurrentRequestIds.map(
        (requestId) => `alias-${requestId}`,
      ),
    });
    const concurrentClaims = await Promise.all([
      coordination.claimPendingPermissionCallback({
        claim: batchClaim({
          id: 'claim-concurrent-a',
          batchId: concurrentBatchId,
          providerAlias: 'alias-req-concurrent-1',
        }),
      }),
      coordination.claimPendingPermissionCallback({
        claim: batchClaim({
          id: 'claim-concurrent-b',
          batchId: concurrentBatchId,
          providerAlias: 'alias-req-concurrent-2',
        }),
      }),
    ]);
    expect(
      concurrentClaims.map((group) => group?.members.length ?? 0).sort(),
    ).toEqual([0, 2]);
    expect(
      new Set(
        concurrentClaims.flatMap((group) =>
          group?.prompt.claim ? [group.prompt.claim.id] : [],
        ),
      ).size,
    ).toBe(1);

    const missingBatchId = 'batch:missing-member:2';
    const missingRequestIds = ['req-missing-1', 'req-missing-2'];
    await createBatchMember({
      requestId: missingRequestIds[0]!,
      expiresAt: toIso(nowMs() + 60_000),
    });
    await expect(
      bindPermissionPrompt({
        interactionId: missingBatchId,
        requestIds: missingRequestIds,
        sourceAgentFolder,
        providerAliases: [`alias-${missingRequestIds[0]}`],
      }),
    ).resolves.toBeNull();
    await expect(
      coordination.claimPendingPermissionCallback({
        claim: batchClaim({
          id: 'claim-missing-member',
          batchId: missingBatchId,
          providerAlias: `alias-${missingRequestIds[0]}`,
        }),
      }),
    ).resolves.toBeNull();

    const staleBatchId = 'batch:stale-member:2';
    const staleRequestIds = ['req-stale-1', 'req-stale-2'];
    await createBatchMember({
      requestId: staleRequestIds[0]!,
      expiresAt: toIso(nowMs() + 60_000),
    });
    await createBatchMember({
      requestId: staleRequestIds[1]!,
      expiresAt: toIso(nowMs() - 60_000),
    });
    await expect(
      bindPermissionPrompt({
        interactionId: staleBatchId,
        requestIds: staleRequestIds,
        sourceAgentFolder,
        providerAliases: [`alias-${staleRequestIds[0]}`],
      }),
    ).resolves.toBeNull();

    const expiredBatchId = 'batch:expired-after-bind:2';
    const expiredRequestIds = [
      'req-expired-after-bind-1',
      'req-expired-after-bind-2',
    ];
    await createBatchMember({
      requestId: expiredRequestIds[0]!,
      expiresAt: toIso(nowMs() + 60_000),
    });
    await createBatchMember({
      requestId: expiredRequestIds[1]!,
      expiresAt: toIso(nowMs() + 60_000),
    });
    await expect(
      bindPermissionPrompt({
        interactionId: expiredBatchId,
        requestIds: expiredRequestIds,
        sourceAgentFolder,
        providerAliases: [`alias-${expiredRequestIds[0]}`],
      }),
    ).resolves.not.toBeNull();
    const decidedAt = toIso(nowMs() + 120_000);
    await expect(
      coordination.claimPendingPermissionCallback({
        claim: batchClaim({
          id: 'claim-expired-member',
          batchId: expiredBatchId,
          providerAlias: `alias-${expiredRequestIds[0]}`,
          decidedAt,
        }),
      }),
    ).resolves.toBeNull();
    await expect(
      coordination.findPendingPermissionPrompt({
        scope: {
          appId: 'default',
          sourceAgentFolder,
          interactionId: expiredBatchId,
        },
        includeTerminalSettlement: true,
      }),
    ).resolves.toMatchObject({
      prompt: { claim: null, settlementState: 'open' },
    });
  });

  it('atomically claims an individual permission callback after batch review', async () => {
    const requestId = 'req-individual-claim';
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      interactionId: requestId,
    };
    const claim = {
      id: 'claim-individual-1',
      scope,
      intent: {
        mode: 'allow_once',
        approverRef: 'user:approver',
        decidedAt: nowIso(),
      },
      match: {
        kind: 'individual',
        canonicalId: requestId,
        providerAliases: ['opaque-individual-callback'],
      },
    } satisfies PermissionCallbackClaim;
    const request = {
      requestId,
      sourceAgentFolder: 'scheduler_agent',
      targetJid: 'tg:worker-coordination',
      toolName: 'Bash',
    };
    await createPermissionMember({ requestId, payload: { request } });
    await createPermissionMember({ requestId: 'req-old-sibling' });
    const oldBatchId = 'batch:old:2';
    const oldBatch = await bindPermissionPrompt({
      interactionId: oldBatchId,
      requestIds: [requestId, 'req-old-sibling'],
      providerAliases: ['old-batch-alias'],
    });
    const oldBatchClaim = {
      id: 'claim-old-batch-review',
      scope: {
        appId: 'default',
        sourceAgentFolder: 'scheduler_agent',
        interactionId: oldBatchId,
      },
      intent: {
        mode: 'allow_persistent_rule',
        approverRef: 'user:approver',
        decidedAt: nowIso(),
      },
      match: {
        kind: 'batch',
        canonicalId: oldBatchId,
        providerAliases: ['old-batch-alias'],
      },
    } satisfies PermissionCallbackClaim;
    const claimedOldBatch = await coordination.claimPendingPermissionCallback({
      claim: oldBatchClaim,
    });
    expect(claimedOldBatch?.members).toHaveLength(2);
    await expect(
      coordination.settlePendingPermissionCallback({ claim: oldBatchClaim }),
    ).resolves.toBe(true);
    configurePendingInteractionDurability({ repository: coordination });
    await expect(
      bindPendingPermissionInteractionMessage({
        request,
        decisionOptions: ['allow_once', 'cancel'],
        callbackId: 'opaque-individual-callback',
      }),
    ).resolves.toBe(true);
    const rebound = await coordination.findPendingPermissionPrompt({ scope });
    expect(rebound).toMatchObject({
      prompt: {
        interactionId: requestId,
        parentEnvelopeId: oldBatch?.prompt.id,
        matchKind: 'individual',
        providerAliases: ['opaque-individual-callback'],
        settlementState: 'open',
      },
      members: [{ requestId }],
    });

    await expect(
      coordination.claimPendingPermissionCallback({ claim }),
    ).resolves.toMatchObject({ members: [{ requestId }] });
    await expect(
      coordination.claimPendingPermissionCallback({
        claim: { ...claim, id: 'claim-individual-loser' },
      }),
    ).resolves.toBeNull();

    const claimed = await coordination.findPendingPermissionPrompt({ scope });
    expect(claimed).toMatchObject({
      prompt: {
        claim: storedPermissionClaim(claim),
        settlementState: 'claimed',
      },
      members: [{ requestId }],
    });
    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: `default:permission:scheduler_agent:${requestId}`,
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
      }),
    ).resolves.toBe(false);
    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: `default:permission:scheduler_agent:${requestId}`,
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
        permissionCallbackClaim: { id: claim.id, scope },
      }),
    ).resolves.toBe(true);
    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: `default:permission:scheduler_agent:${requestId}`,
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
        permissionCallbackClaim: { id: claim.id, scope },
      }),
    ).resolves.toBe(true);
    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: `default:permission:scheduler_agent:${requestId}`,
        status: 'resolved',
        resolution: { approved: false, mode: 'cancel' },
        approverRef: 'user:approver',
        permissionCallbackClaim: { id: claim.id, scope },
      }),
    ).resolves.toBe(false);
  });

  it.each(['active', 'settled'] as const)(
    'atomically expires %s Review-each state as a system cancellation',
    async (state) => {
      const sourceAgentFolder = 'scheduler_agent';
      const batchId = `batch:expire-review-each:${state}`;
      const requestIds = [
        `req-expire-review-each-${state}-1`,
        `req-expire-review-each-${state}-2`,
      ];
      for (const requestId of requestIds) {
        await createPermissionMember({ requestId, sourceAgentFolder });
      }
      await bindPermissionPrompt({
        interactionId: batchId,
        requestIds,
        sourceAgentFolder,
        providerAliases: requestIds.map((requestId) => `alias-${requestId}`),
      });
      const claim = {
        id: `claim-expire-review-each-${state}`,
        scope: {
          appId: 'default',
          sourceAgentFolder,
          interactionId: batchId,
        },
        intent: {
          mode: 'allow_persistent_rule',
          approverRef: 'user:approver',
          decidedAt: nowIso(),
        },
        match: {
          kind: 'batch',
          canonicalId: batchId,
          providerAliases: [`alias-${requestIds[0]}`],
        },
      } satisfies PermissionCallbackClaim;
      const claimed = await coordination.claimPendingPermissionCallback({
        claim,
      });
      expect(claimed?.members).toHaveLength(2);
      if (state === 'settled') {
        await expect(
          coordination.settlePendingPermissionCallback({ claim }),
        ).resolves.toBe(true);
      }

      const expired = await coordination.expirePendingPermissionReviewEach({
        claim,
        now: '2026-07-19T00:00:00.000Z',
      });
      expect(expired).toMatchObject({
        prompt: {
          claim: storedPermissionClaim(claim),
          settlementState: 'review_each_expired',
        },
      });
      expect(expired?.members).toHaveLength(2);
      expect(new Date(expired!.prompt.settledAt!).toISOString()).toBe(
        '2026-07-19T00:00:00.000Z',
      );
      configurePendingInteractionDurability({ repository: coordination });
      for (const requestId of requestIds) {
        const replayed = await replayPersistedPermissionDecisionForRequest({
          appId: 'default',
          sourceAgentFolder,
          requestId,
        });
        expect(replayed).toMatchObject({
          approved: false,
          mode: 'cancel',
          decidedBy: 'system',
          permissionCallbackClaim: {
            id: `${claim.id}:expired:${requestId}`,
            scope: {
              appId: 'default',
              sourceAgentFolder,
              interactionId: requestId,
            },
          },
        });
      }
      await expect(
        coordination.expirePendingPermissionReviewEach({
          claim,
          now: '2026-07-19T00:01:00.000Z',
        }),
      ).resolves.toBeNull();
    },
  );

  it('treats a freshly recovered settled Review-each expiration as already decided', async () => {
    const { providerAlias, scope } =
      await expireSettledReviewEachBatch('fresh-recovery');
    configurePendingInteractionDurability(null);
    configurePendingInteractionDurability({ repository: coordination });

    const recovered = await findDurablePermissionInteractionByRequestId({
      scope,
    });
    expect(recovered).toMatchObject({
      scope,
      requestId: scope.interactionId,
      batchCallbackId: scope.interactionId,
    });
    expect(recovered?.claim).toBeUndefined();
    await expect(
      claimPermissionInteractionCallback({
        scope,
        mode: 'allow_once',
        approverRef: 'user:approver-after-restart',
        matchKind: 'batch',
        providerAlias,
      }),
    ).resolves.toEqual({ status: 'already_decided' });
  });

  it('preserves the original provider alias after settled Review-each expiration and reports it already decided', async () => {
    const { providerAlias, scope } =
      await expireSettledReviewEachBatch('provider-alias');
    configurePendingInteractionDurability(null);
    configurePendingInteractionDurability({ repository: coordination });

    const recovered = await findDurablePermissionInteractionByRequestId({
      scope,
      providerAlias,
    });
    expect(recovered?.providerAliases).toContain(providerAlias);
    await expect(
      claimPermissionInteractionCallback({
        scope,
        mode: 'allow_once',
        approverRef: 'user:approver-after-restart',
        matchKind: 'batch',
        providerAlias,
      }),
    ).resolves.toEqual({ status: 'already_decided' });
  });

  it('allows exactly one concurrent Review-each expiration and keeps every batch member readable', async () => {
    const sourceAgentFolder = 'scheduler_agent';
    const batchId = 'batch:expire-review-each:concurrent';
    const requestIds = [
      'req-expire-review-each-concurrent-1',
      'req-expire-review-each-concurrent-2',
    ];
    for (const requestId of requestIds) {
      await createPermissionMember({ requestId, sourceAgentFolder });
    }
    await bindPermissionPrompt({
      interactionId: batchId,
      requestIds,
      sourceAgentFolder,
      providerAliases: requestIds.map((requestId) => `alias-${requestId}`),
    });
    const claim = {
      id: 'claim-expire-review-each-concurrent',
      scope: {
        appId: 'default',
        sourceAgentFolder,
        interactionId: batchId,
      },
      intent: {
        mode: 'allow_persistent_rule',
        approverRef: 'user:approver',
        decidedAt: nowIso(),
      },
      match: {
        kind: 'batch',
        canonicalId: batchId,
        providerAliases: [`alias-${requestIds[0]}`],
      },
    } satisfies PermissionCallbackClaim;
    const claimed = await coordination.claimPendingPermissionCallback({
      claim,
    });
    expect(claimed?.members).toHaveLength(2);
    await expect(
      coordination.settlePendingPermissionCallback({ claim }),
    ).resolves.toBe(true);

    const expirations = await Promise.all([
      coordination.expirePendingPermissionReviewEach({
        claim,
        now: '2026-07-19T00:00:00.000Z',
      }),
      coordination.expirePendingPermissionReviewEach({
        claim,
        now: '2026-07-19T00:00:00.000Z',
      }),
    ]);
    expect(
      expirations.map((group) => group?.members.length ?? 0).sort(),
    ).toEqual([0, 2]);

    const recovered = await coordination.findPendingPermissionPrompt({
      scope: claim.scope,
      includeTerminalSettlement: true,
    });
    expect(recovered).toMatchObject({
      prompt: {
        claim: storedPermissionClaim(claim),
        settlementState: 'review_each_expired',
      },
    });
    expect(recovered?.members).toHaveLength(2);
    configurePendingInteractionDurability({ repository: coordination });
    for (const requestId of requestIds) {
      await expect(
        replayPersistedPermissionDecisionForRequest({
          appId: 'default',
          sourceAgentFolder,
          requestId,
        }),
      ).resolves.toMatchObject({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        permissionCallbackClaim: {
          id: `${claim.id}:expired:${requestId}`,
          scope: {
            appId: 'default',
            sourceAgentFolder,
            interactionId: requestId,
          },
        },
      });
    }
  });

  it('scopes a colliding request id to the authorized agent', async () => {
    const requestId = 'req-cross-agent-collision';
    const providerAlias = 'opaque-cross-agent-collision';
    for (const sourceAgentFolder of ['agent-a', 'agent-b']) {
      await createPermissionMember({ requestId, sourceAgentFolder });
      await bindPermissionPrompt({
        interactionId: requestId,
        requestIds: [requestId],
        sourceAgentFolder,
        providerAliases: [providerAlias],
      });
    }
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      interactionId: requestId,
    };
    const claim = {
      id: 'claim-cross-agent-collision',
      scope,
      intent: {
        mode: 'allow_once',
        approverRef: 'user:approver',
        decidedAt: nowIso(),
      },
      match: {
        kind: 'individual',
        canonicalId: requestId,
        providerAliases: [providerAlias],
      },
    } satisfies PermissionCallbackClaim;

    await expect(
      coordination.claimPendingPermissionCallback({ claim }),
    ).resolves.toMatchObject({ members: [{ requestId }] });
    const agentA = await coordination.findPendingPermissionPrompt({ scope });
    const agentB = await coordination.findPendingPermissionPrompt({
      scope: { ...scope, sourceAgentFolder: 'agent-b' },
    });
    expect(agentA?.prompt).toMatchObject({
      claim: storedPermissionClaim(claim),
      settlementState: 'claimed',
    });
    expect(agentB?.prompt).toMatchObject({
      claim: null,
      providerAliases: [providerAlias],
      settlementState: 'open',
    });

    await expect(
      coordination.releasePendingPermissionCallback({ claim }),
    ).resolves.toBe(true);
    const released = await coordination.findPendingPermissionPrompt({
      scope,
    });
    expect(released?.prompt).toMatchObject({
      claim: null,
      providerAliases: [providerAlias],
      settlementState: 'open',
    });
  });

  it('fails closed when a provider message identifies multiple prompts', async () => {
    const message = {
      externalPromptProvider: 'telegram',
      externalPromptConversationId: 'ambiguous-conversation',
      externalPromptMessageId: 'ambiguous-message',
      externalPromptThreadId: null,
    } as const;
    await createPermissionMember({
      requestId: 'ambiguous-message-a',
      sourceAgentFolder: 'agent-a',
    });
    await bindPermissionPrompt({
      interactionId: 'ambiguous-message-a',
      requestIds: ['ambiguous-message-a'],
      sourceAgentFolder: 'agent-a',
      ...message,
    });
    await expect(
      coordination.findPendingPermissionPromptByMessage({
        appId: 'default',
        provider: 'telegram',
        conversationId: 'ambiguous-conversation',
        externalMessageId: 'ambiguous-message',
      }),
    ).resolves.toMatchObject({
      prompt: { sourceAgentFolder: 'agent-a' },
    });

    await createPermissionMember({
      requestId: 'ambiguous-message-b',
      sourceAgentFolder: 'agent-b',
    });
    await bindPermissionPrompt({
      interactionId: 'ambiguous-message-b',
      requestIds: ['ambiguous-message-b'],
      sourceAgentFolder: 'agent-b',
      ...message,
    });
    await expect(
      coordination.findPendingPermissionPromptByMessage({
        appId: 'default',
        provider: 'telegram',
        conversationId: 'ambiguous-conversation',
        externalMessageId: 'ambiguous-message',
      }),
    ).resolves.toBeNull();
  });

  it('rejects prompt rebinding after a callback claim and does not revive settled callbacks', async () => {
    const callbackId = 'batch:req-binding-race:1';
    const requestId = 'req-binding-race';
    const idempotencyKey =
      'default:permission:scheduler_agent:req-binding-race';
    const claim = {
      id: 'claim-binding-race',
      scope: {
        appId: 'default',
        sourceAgentFolder: 'scheduler_agent',
        interactionId: callbackId,
      },
      intent: {
        mode: 'allow_once',
        approverRef: 'user:approver',
        decidedAt: nowIso(),
      },
      match: {
        kind: 'batch',
        canonicalId: callbackId,
        providerAliases: ['opaque-binding-race'],
      },
    } satisfies PermissionCallbackClaim;
    await createPermissionMember({ requestId });
    await bindPermissionPrompt({
      interactionId: callbackId,
      requestIds: [requestId],
      providerAliases: ['opaque-binding-race'],
      mode: 'batch',
    });
    const stalePayload = (
      await coordination.listPendingInteractions({ appId: 'default' })
    ).find((row) => row.idempotencyKey === idempotencyKey)!.payload;

    await expect(
      coordination.claimPendingPermissionCallback({ claim }),
    ).resolves.toMatchObject({ members: [{ requestId }] });
    await expect(
      bindPermissionPrompt({
        interactionId: 'req-binding-race-new-prompt',
        requestIds: [requestId],
        providerAliases: ['message-after-claim'],
      }),
    ).resolves.toBeNull();

    const rebound = await coordination.findPendingPermissionPrompt({
      scope: claim.scope,
    });
    expect(rebound).toMatchObject({
      prompt: {
        interactionId: callbackId,
        claim: storedPermissionClaim(claim),
        providerAliases: ['opaque-binding-race'],
        settlementState: 'claimed',
      },
      members: [{ requestId }],
    });

    const refreshedWhileClaimed = await coordination.createPendingInteraction({
      id: 'interaction-binding-race-refresh-while-claimed',
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      requestId,
      kind: 'permission',
      payload: stalePayload,
      idempotencyKey,
      expiresAt: toIso(nowMs() + 60_000),
    });
    expect(refreshedWhileClaimed.id).toBe(
      'interaction-scheduler_agent-req-binding-race',
    );
    await expect(
      coordination.findPendingPermissionPrompt({ scope: claim.scope }),
    ).resolves.toMatchObject({
      prompt: {
        claim: storedPermissionClaim(claim),
        settlementState: 'claimed',
      },
    });

    await expect(
      coordination.settlePendingPermissionCallback({
        claim: { id: claim.id, scope: claim.scope },
      }),
    ).resolves.toBe(true);
    const refreshed = await coordination.createPendingInteraction({
      id: 'interaction-binding-race-refresh',
      appId: 'default',
      sourceAgentFolder: 'scheduler_agent',
      requestId,
      kind: 'permission',
      payload: stalePayload,
      idempotencyKey,
      expiresAt: toIso(nowMs() + 60_000),
    });
    expect(refreshed.id).toBe('interaction-scheduler_agent-req-binding-race');
    await expect(
      coordination.findPendingPermissionPrompt({
        scope: claim.scope,
        includeTerminalSettlement: true,
      }),
    ).resolves.toMatchObject({
      prompt: {
        claim: storedPermissionClaim(claim),
        settlementState: 'settled',
      },
    });
    await expect(
      coordination.updatePendingInteractionPayload({
        idempotencyKey,
        update: (payload) => ({
          ...payload,
          externalPromptMessageId: 'message-after-settlement',
        }),
      }),
    ).resolves.toBe(true);
    const settled = (
      await coordination.listPendingInteractions({ appId: 'default' })
    ).find((row) => row.idempotencyKey === idempotencyKey)!;
    expect(settled.payload).toMatchObject({
      externalPromptMessageId: 'message-after-settlement',
    });
    await expect(
      coordination.findPendingPermissionPrompt({
        scope: claim.scope,
        includeTerminalSettlement: true,
      }),
    ).resolves.toMatchObject({
      prompt: {
        claim: storedPermissionClaim(claim),
        settlementState: 'settled',
      },
    });
  });

  it('keeps pending members bound to an ordinary settled batch claim', async () => {
    const sourceAgentFolder = 'scheduler_agent';
    const interactionId = 'batch:ordinary-settled:2';
    const requestIds = ['req-ordinary-settled-1', 'req-ordinary-settled-2'];
    for (const requestId of requestIds) {
      await createPermissionMember({ requestId, sourceAgentFolder });
    }
    await bindPermissionPrompt({
      interactionId,
      requestIds,
      sourceAgentFolder,
      providerAliases: ['ordinary-settled-alias'],
    });
    const scope = { appId: 'default', sourceAgentFolder, interactionId };
    const claim = {
      id: 'claim-ordinary-settled',
      scope,
      intent: {
        mode: 'allow_once',
        approverRef: 'user:approver',
        decidedAt: nowIso(),
      },
      match: {
        kind: 'batch',
        canonicalId: interactionId,
        providerAliases: ['ordinary-settled-alias'],
      },
    } satisfies PermissionCallbackClaim;
    await expect(
      coordination.claimPendingPermissionCallback({ claim }),
    ).resolves.toMatchObject({ members: [{}, {}] });
    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: permissionIdempotencyKey(
          sourceAgentFolder,
          requestIds[0]!,
        ),
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
        permissionCallbackClaim: { id: claim.id, scope },
      }),
    ).resolves.toBe(true);

    await expect(
      bindPermissionPrompt({
        interactionId: requestIds[1]!,
        requestIds: [requestIds[1]!],
        sourceAgentFolder,
        providerAliases: ['contradictory-individual-alias'],
        mode: 'individual',
      }),
    ).resolves.toBeNull();
    await expect(
      coordination.findPendingPermissionPrompt({
        scope,
        includeTerminalSettlement: true,
      }),
    ).resolves.toMatchObject({
      prompt: {
        claim: storedPermissionClaim(claim),
        settlementState: 'settled',
      },
      members: [{ requestId: requestIds[1] }],
    });
    await expect(
      coordination.resolvePendingInteraction({
        idempotencyKey: permissionIdempotencyKey(
          sourceAgentFolder,
          requestIds[1]!,
        ),
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
        permissionCallbackClaim: { id: claim.id, scope },
      }),
    ).resolves.toBe(true);
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

  it('does not release stale-worker slots while their run lease is still active', async () => {
    await coordination.registerWorker({
      id: 'w-stale-slot-active-lease',
      bootNonce: 'nonce-w-stale-slot-active-lease',
      now: toIso(nowMs() - 120_000),
    });
    await runtime.ops.upsertJob(makeJob('job-slot-active-lease'));
    await createRunForJob('job-slot-active-lease', 'run-slot-active-lease');
    const lease = await coordination.claimRunLease({
      runId: 'run-slot-active-lease',
      jobId: 'job-slot-active-lease',
      workerInstanceId: 'w-stale-slot-active-lease',
      ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();
    await expect(
      coordination.acquireRunSlot({
        slotKey: 'workspace:active-lease',
        holderId: 'holder-active-lease',
        capacity: 1,
        ttlMs: 60_000,
        runId: 'run-slot-active-lease',
        workerInstanceId: 'w-stale-slot-active-lease',
      }),
    ).resolves.toBe(true);

    await expect(
      coordination.releaseRunSlotsForStaleWorkers!({
        staleBefore: toIso(nowMs() - 60_000),
      }),
    ).resolves.toBe(0);
    await expect(
      runtime.service.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM "${runtime.schemaName}".run_slots
         WHERE slot_key = $1 AND holder_id = $2`,
        ['workspace:active-lease', 'holder-active-lease'],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    await expect(
      coordination.settleRunLease({
        runId: 'run-slot-active-lease',
        leaseToken: lease!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toBe(true);
    await expect(
      coordination.releaseRunSlotsForStaleWorkers!({
        staleBefore: toIso(nowMs() - 60_000),
      }),
    ).resolves.toBe(1);
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
