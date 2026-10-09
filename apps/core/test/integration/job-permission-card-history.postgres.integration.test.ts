import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  canonicalJobPermissionNeedIdentity,
  JobPermissionDurabilityService,
} from '@core/application/interactions/job-permission-durability.js';
import { initialCard } from '@core/application/interactions/job-permission-card-projection.js';
import type { ChannelWiring } from '@core/app/bootstrap/channel-wiring-types.js';
import { setupJobPermissionDurability } from '@core/app/bootstrap/job-permission-wiring-setup.js';
import {
  configureJobPermissionLeaseExtensionReader,
  jobPermissionLeaseExtensionMs,
} from '@core/jobs/execution-lease.js';
import { jobPermissionCardActions } from '@core/domain/job-permission-card-actions.js';
import {
  FINISHED_NEED_STATES,
  type FinishedNeedState,
} from '@core/domain/job-permission-card-history.js';
import type {
  JobPermissionCardRecord,
  JobPermissionCardRevision,
} from '@core/domain/ports/job-permission-durability.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

const APP_ID = 'default';
const CONVERSATION_ID = 'conversation-card-history';
const APPROVER = 'approver-1';

maybeDescribe('job permission card history', () => {
  let runtime: PostgresIntegrationRuntime;
  let service: JobPermissionDurabilityService;
  // The runtime's own wiring: it installs the scheduler's lease heartbeat
  // reader and its reconcile is what the 5-second reconcile loop runs. Only
  // the provider edge (sends and receipts) is faked.
  let wired: NonNullable<ReturnType<typeof setupJobPermissionDurability>>;

  const repository = () => runtime.repositories.workerCoordination;
  const query = (text: string, values: unknown[] = []) =>
    runtime.service.pool.query(text, values);

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'jobperm_card_history',
    });
    const now = new Date().toISOString();
    await query(
      `INSERT INTO apps (id, slug, name, status, created_at, updated_at)
         VALUES ($1, $1, $1, 'active', $2, $2) ON CONFLICT (id) DO NOTHING`,
      [APP_ID, now],
    );
    await query(
      `INSERT INTO conversations (id, app_id, provider_account_id, external_ref_json, kind, title, status, created_at, updated_at)
         VALUES ($1, $2, 'provider:test', '{}', 'group', 'Card history', 'active', $3, $3)`,
      [CONVERSATION_ID, APP_ID, now],
    );
    service = new JobPermissionDurabilityService(
      repository(),
      {
        authorizeActor: async () => true,
        releaseSlot: async () => true,
        acquireSlot: async () => true,
        // Runs named dead-* ended while their request waited.
        isRunAlive: async ({ runId }) => !runId.startsWith('dead-'),
        revalidate: async (input) => ({
          kind: 'approved',
          grantAtoms: [...input.renderedGrantAtoms],
        }),
        persistGrant: async () => undefined,
        deliverWaiterResponse: async () => undefined,
        enqueueRunAgain: async () => undefined,
      },
      {
        now: () => new Date().toISOString(),
        monotonicMs: () => performance.now(),
        hostBootId: () => 'boot-1',
      },
      { maxRows: 4, maxGrantAtomsPerRow: 4 },
    );
    wired = setupJobPermissionDurability({
      workerCoordination: repository(),
      opsRepository: runtime.ops,
      channelWiring: {
        getRuntimeAppId: () => APP_ID,
        isControlApproverAllowed: async () => true,
      } as unknown as ChannelWiring,
      getPermissionRuntimeSettings: () => ({ agents: {}, permissions: {} }),
      getToolRepository: () => runtime.repositories.tools,
      getSkillRepository: () => runtime.repositories.skills,
      createJobTrigger: async ({ triggerId }) => ({
        status: 'completed',
        triggerId,
      }),
    })!;
  });

  afterAll(async () => {
    configureJobPermissionLeaseExtensionReader(null);
    await runtime?.cleanup();
  });

  function attach(
    jobId: string,
    runId = 'run-1',
    atoms = ['RunCommand(npm test *)'],
    using: JobPermissionDurabilityService = service,
  ) {
    return using.attachNeed({
      appId: APP_ID,
      jobId,
      sourceAgentFolder: 'main_agent',
      conversationId: CONVERSATION_ID,
      canonicalIdentity: canonicalJobPermissionNeedIdentity(atoms),
      displayLabel: 'Run tests',
      renderedGrantAtoms: atoms,
      waiter: {
        id: `waiter:${runId}`,
        requestId: `request:${runId}`,
        runId,
        runLeaseToken: `lease:${runId}`,
        runLeaseFencingVersion: 1,
      },
    });
  }

  async function state(jobId: string) {
    const current = await repository().getJobPermissionState({
      appId: APP_ID,
      jobId,
    });
    return current!;
  }

  function attachOnce(jobId: string, run: number, runId = `run-${run}`) {
    return service.attachNeed({
      appId: APP_ID,
      jobId,
      sourceAgentFolder: 'main_agent',
      conversationId: CONVERSATION_ID,
      canonicalIdentity: `request-${run}`,
      displayLabel: `Run once ${run}`,
      grant: 'once',
      renderedGrantAtoms: [],
      waiter: {
        id: `waiter:${runId}`,
        requestId: `request-${run}`,
        runId,
        runLeaseToken: `lease:${runId}`,
        runLeaseFencingVersion: 1,
      },
    });
  }

  async function needRowStatuses(jobId: string) {
    const result = await query(
      `SELECT id, status FROM pending_interactions
        WHERE kind = 'job_permission_need' AND payload_json->>'jobId' = $1`,
      [jobId],
    );
    return new Map(
      (result.rows as Array<{ id: string; status: string }>).map((row) => [
        row.id,
        row.status,
      ]),
    );
  }

  async function openNeedRows(jobId: string) {
    return [...(await needRowStatuses(jobId)).values()].filter(
      (status) => status === 'pending',
    ).length;
  }

  async function storedCardBytes(jobId: string): Promise<number> {
    const result = await query(
      `SELECT octet_length(payload_json::text) AS bytes FROM pending_interactions
        WHERE kind = 'job_permission_card' AND payload_json->>'jobId' = $1`,
      [jobId],
    );
    return Number(result.rows[0].bytes);
  }

  // Settles every open card send the way the outbound worker would; without a
  // provider message id the outcome is ambiguous.
  async function settleOpenCardSends(providerMessageId: string | null) {
    const sentAt = new Date().toISOString();
    const sent = await query(
      `UPDATE outbound_deliveries SET status = 'sent', updated_at = $1
        WHERE profile_id = 'job_permission_card' AND status = 'pending'
        RETURNING id`,
      [sentAt],
    );
    if (!providerMessageId) return;
    for (const { id } of sent.rows as Array<{ id: string }>) {
      await query(
        `INSERT INTO outbound_delivery_receipts
           (id, delivery_id, item_id, idempotency_key, provider_message_id, sent_at, created_at)
         VALUES ($1, $2, $3, $1, $4, $5, $5)`,
        [`receipt:${id}`, id, `${id}:item`, providerMessageId, sentAt],
      );
    }
  }

  it('resends an ambiguous card send once instead of on every tick', async () => {
    const jobId = 'job-ambiguous-once';
    await attach(jobId);
    await settleOpenCardSends(null);

    for (let tick = 0; tick < 20; tick += 1) {
      await service.reconcile();
      await settleOpenCardSends('ambiguous-once-message');
    }

    const card = (await state(jobId)).card;
    expect(card.revision).toBe(2);
    expect(card.revisionDeliveries).toEqual([
      expect.objectContaining({ revision: 2, status: 'delivered' }),
    ]);
  });

  it('stops resending a card whose every send is ambiguous after the attempt cap', async () => {
    const jobId = 'job-ambiguous-always';
    await attach(jobId);

    const revisionsPerTick: number[] = [];
    for (let tick = 0; tick < 30; tick += 1) {
      await settleOpenCardSends(null);
      await service.reconcile();
      revisionsPerTick.push((await state(jobId)).card.revision);
    }

    const card = (await state(jobId)).card;
    // Four attempts for the asking card, four for the handed-off card.
    expect(card.revision).toBeLessThanOrEqual(8);
    expect(revisionsPerTick.slice(-10)).toEqual(Array(10).fill(card.revision));
    const open = await repository().listJobPermissionCardsForReconciliation();
    expect(open.map((entry) => entry.jobId)).not.toContain(jobId);
  });

  it('keeps a recurring job card small across more than a thousand runs and still delivers the latest', async () => {
    const jobId = 'job-recurring';
    await attach(jobId, 'run-0', undefined, wired);
    await settleOpenCardSends('card-message-1');
    await wired.reconcile();

    // Every run heartbeats its lease the way the scheduler does, and the
    // reconcile loop keeps ticking between runs.
    for (let run = 1; run <= 1_001; run += 1) {
      const heartbeat = {
        appId: APP_ID,
        jobId,
        sourceAgentFolder: 'main_agent',
        runId: `run-${run}`,
      };
      await jobPermissionLeaseExtensionMs(heartbeat);
      await jobPermissionLeaseExtensionMs(heartbeat);
      if (run % 100 === 0) {
        await settleOpenCardSends('card-message-1');
        await wired.reconcile();
      }
    }
    await attach(jobId, 'run-1002', ['RunCommand(npm run build *)'], wired);
    const latest = (await state(jobId)).card.revision;
    await settleOpenCardSends('card-message-1');
    await wired.reconcile();

    const card = (await state(jobId)).card;
    expect(card.pendingBudgets).toEqual([]);
    expect(card.revisions.length).toBeLessThanOrEqual(4);
    expect(await storedCardBytes(jobId)).toBeLessThan(20_000);
    expect(card.currentProviderRevision).toBe(latest);
    expect(
      card.revisionDeliveries.find(({ revision }) => revision === latest),
    ).toMatchObject({ status: 'delivered' });
  }, 300_000);

  it('keeps one card small past a thousand revisions and treats a tap on a dropped one as stale', async () => {
    const jobId = 'job-many-revisions';
    await attach(jobId);
    let tappedRevision: JobPermissionCardRevision | undefined;

    while ((await state(jobId)).card.revision <= 1_000) {
      await settleOpenCardSends('card-message-1');
      await service.reconcile();
      let current = await state(jobId);
      const need = current.needs[0]!;
      await service.decideCard({
        appId: APP_ID,
        jobId,
        sourceAgentFolder: 'main_agent',
        actorRef: APPROVER,
        revision: current.card.revision,
        decision: 'deny',
        needId: need.id,
        askingEpoch: need.askingEpoch,
      });
      await service.reconcile();
      current = await state(jobId);
      await service.reconsider({
        appId: APP_ID,
        jobId,
        sourceAgentFolder: 'main_agent',
        actorRef: APPROVER,
        revision: current.card.revision,
        needId: need.id,
        askingEpoch: need.askingEpoch,
      });
      tappedRevision ??= (await state(jobId)).card.revisions.at(-1);
    }

    await settleOpenCardSends('card-message-1');
    await service.reconcile();
    const card = (await state(jobId)).card;
    expect(card.revision).toBeGreaterThan(1_000);
    expect(card.revisions.length).toBeLessThanOrEqual(4);
    expect(await storedCardBytes(jobId)).toBeLessThan(20_000);
    expect(card.currentProviderRevision).toBe(card.revision);
    const oldDeny = jobPermissionCardActions(
      card.callbackKey,
      tappedRevision!,
    ).find((action) => action.label === 'Deny')!;
    await expect(
      service.decideCardAction({
        actor: { actorRef: APPROVER },
        token: oldDeny.token,
      }),
    ).resolves.toEqual({ status: 'stale' });
  }, 600_000);

  it('keeps a settled once-need while a pending rerun requires it, and removes old settled rows', async () => {
    const jobId = 'job-once-rerun';
    for (let run = 1; run <= 5; run += 1) await attachOnce(jobId, run);
    const { needs } = await state(jobId);
    const byIdentity = (identity: string) =>
      needs.find((need) => need.canonicalIdentity === identity)!;
    const gated = byIdentity('request-1');
    const free = byIdentity('request-2');
    const applied = (needId: string, priorRunId?: string) =>
      repository().mutateJobPermissionState({
        appId: APP_ID,
        jobId,
        initialCard: initialCard({ appId: APP_ID, jobId }, gated!.createdAt),
        mutate: (current) => {
          for (const need of current.needs) {
            if (need.id !== needId) continue;
            need.state = 'applied';
            need.grantAppliedAt = need.updatedAt;
            for (const waiter of need.waiters) waiter.state = 'delivered';
          }
          if (priorRunId) {
            current.card.rerunBarriers.push({
              priorRunId,
              requiredNeeds: [{ needId, askingEpoch: 1 }],
              requestedAt: gated!.createdAt,
              requestedBy: APPROVER,
              enqueuedAt: null,
            });
          }
          return { state: current, result: undefined };
        },
      });
    await applied(gated!.id, 'run-1');
    // Four newer finished needs push both older ones past the newest three.
    for (let run = 2; run <= 5; run += 1) {
      await applied(byIdentity(`request-${run}`).id);
    }

    let statuses = await needRowStatuses(jobId);
    expect(statuses.get(gated!.id)).toBe('pending');
    expect(statuses.get(free!.id)).toBe('resolved');
    expect(
      (await state(jobId)).needs
        .map(({ canonicalIdentity }) => canonicalIdentity)
        .sort(),
    ).toEqual(['request-1', 'request-3', 'request-4', 'request-5']);

    // The rerun is enqueued; its need settles on that write.
    await repository().mutateJobPermissionState({
      appId: APP_ID,
      jobId,
      initialCard: initialCard({ appId: APP_ID, jobId }, gated!.createdAt),
      mutate: (current) => {
        current.card.rerunBarriers[0]!.enqueuedAt = gated!.createdAt;
        return { state: current, result: undefined };
      },
    });
    statuses = await needRowStatuses(jobId);
    expect(statuses.get(gated!.id)).toBe('resolved');

    // Settled rows older than 30 days go when the next need settles.
    await query(
      `UPDATE pending_interactions SET resolved_at = now() - interval '31 days'
        WHERE id = $1`,
      [free!.id],
    );
    await attachOnce(jobId, 6);
    const sixth = (await state(jobId)).needs.find(
      (need) => need.canonicalIdentity === 'request-6',
    )!;
    await applied(sixth.id);
    statuses = await needRowStatuses(jobId);
    expect(statuses.has(free!.id)).toBe(false);
    expect(statuses.get(gated!.id)).toBe('resolved');
  });

  it('reconciles a new card behind more than a hundred idle cards', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    for (let index = 0; index < 120; index += 1) {
      const card = initialCard(
        {
          appId: APP_ID,
          jobId: `job-idle-${index}`,
          conversationId: CONVERSATION_ID,
        },
        createdAt,
      );
      card.revisionDeliveries = [
        {
          revision: 1,
          deliveryId: `idle-delivery-${index}`,
          status: 'delivered',
          provider: null,
          providerMessageId: `idle-message-${index}`,
          confirmedAt: createdAt,
          reason: null,
          updatedAt: createdAt,
        },
      ];
      await query(
        `INSERT INTO pending_interactions
           (id, app_id, request_id, kind, status, payload_json, idempotency_key, created_at, expires_at)
         VALUES ($1, $2, $3, 'job_permission_card', 'pending', $4, $1, $5, '9999-12-31T23:59:59.999Z')`,
        [card.id, APP_ID, card.jobId, card, createdAt],
      );
    }
    const jobId = 'job-new-card';
    await attach(jobId, undefined, undefined, wired);

    // One tick of the reconcile loop confirms the new card's send.
    await settleOpenCardSends('new-card-message');
    await wired.reconcile();
    expect((await state(jobId)).card).toMatchObject({
      currentProviderMessageId: 'new-card-message',
      currentProviderRevision: 1,
    });
  });

  async function decideOnce(
    jobId: string,
    run: number,
    decision: 'allow' | 'deny',
  ) {
    await attachOnce(jobId, run);
    const current = await state(jobId);
    const need = current.needs.find(
      (candidate) => candidate.canonicalIdentity === `request-${run}`,
    )!;
    await service.decideCard({
      appId: APP_ID,
      jobId,
      sourceAgentFolder: 'main_agent',
      actorRef: APPROVER,
      revision: current.card.revision,
      decision,
      needId: need.id,
      askingEpoch: need.askingEpoch,
    });
  }

  // How a run's one-time request reaches each finished state through the
  // real service, and what the card or a replay still shows afterwards.
  const finishRun: Record<
    FinishedNeedState,
    {
      start: (jobId: string, run: number) => Promise<void>;
      afterwards: (jobId: string) => Promise<void>;
    }
  > = {
    applied: {
      start: (jobId, run) => decideOnce(jobId, run, 'allow'),
      afterwards: async (jobId) => {
        // A replayed request still finds its applied need instead of asking.
        await expect(attachOnce(jobId, 1)).resolves.toMatchObject({
          status: 'applied',
        });
      },
    },
    denied: {
      start: (jobId, run) => decideOnce(jobId, run, 'deny'),
      afterwards: async (jobId) => {
        await expect(attachOnce(jobId, 1)).resolves.toMatchObject({
          status: 'denied',
        });
      },
    },
    // Every run ends before anyone answers, so the request expires.
    cancelled: {
      start: async (jobId, run) => {
        await attachOnce(jobId, run, `dead-run-${run}`);
      },
      afterwards: async (jobId) => {
        // The owner still sees the expired receipt for the latest requests.
        const latest = (await state(jobId)).card.revisions.at(-1)!;
        expect(latest).toMatchObject({ retireOutcome: 'expired' });
        expect(latest.retiredRows).toHaveLength(3);
      },
    },
  };

  it.each(FINISHED_NEED_STATES)(
    'keeps at most three %s once-requests open across hundreds of runs',
    async (finished) => {
      const jobId = `job-once-${finished}`;
      // Each run costs about ten transactions through the real service, so
      // 300 runs keep this to about two minutes; the open-row check fails at
      // run 100 when finished needs stay open.
      for (let run = 1; run <= 300; run += 1) {
        await finishRun[finished].start(jobId, run);
        for (let tick = 0; tick < 3; tick += 1) {
          await settleOpenCardSends('once-message');
          await service.reconcile();
        }
        if (run % 100 === 0) {
          expect(await openNeedRows(jobId)).toBeLessThanOrEqual(3);
        }
      }

      const { card, needs } = await state(jobId);
      // Only the newest three stay, each in the state its run ended in.
      expect(needs.map(({ state }) => state)).toEqual(Array(3).fill(finished));
      expect(
        card.revisions.at(-1)!.representedNeeds.length,
      ).toBeLessThanOrEqual(3);
      const startedAt = performance.now();
      await jobPermissionLeaseExtensionMs({
        appId: APP_ID,
        jobId,
        sourceAgentFolder: 'main_agent',
        runId: 'run-301',
      });
      expect(performance.now() - startedAt).toBeLessThan(500);
      await finishRun[finished].afterwards(jobId);
    },
    600_000,
  );

  it.each(FINISHED_NEED_STATES)(
    'settles all but the newest three %s once-needs and trims request snapshots in the migration',
    async (finished) => {
      const jobId = `job-migrate-${finished}`;
      for (let run = 1; run <= 6; run += 1) await attachOnce(jobId, run);
      await attach(jobId, 'run-7');
      const needs = (await state(jobId)).needs;
      const byIdentity = (identity: string) =>
        needs.find((need) => need.canonicalIdentity === identity)!;
      const gated = byIdentity('request-1');
      const rule = needs.find((need) => need.grant !== 'once')!;
      const setPayload = (id: string, patch: Record<string, unknown>) =>
        query(
          `UPDATE pending_interactions SET payload_json = payload_json || $2::jsonb
            WHERE id = $1`,
          [id, JSON.stringify(patch)],
        );
      // Six finished needs; the card keeps the newest three (runs 4 to 6).
      for (let run = 1; run <= 6; run += 1) {
        await setPayload(byIdentity(`request-${run}`).id, {
          state: finished,
          updatedAt: `2026-10-01T00:00:0${run}.000Z`,
        });
      }
      await setPayload(rule.id, {
        requestSnapshots: Array.from({ length: 8 }, (_, index) => ({
          requestId: `snapshot-${index + 1}`,
          request: {},
        })),
      });
      await query(
        `UPDATE pending_interactions SET payload_json = jsonb_set(payload_json, '{rerunBarriers}', $2::jsonb)
          WHERE kind = 'job_permission_card' AND payload_json->>'jobId' = $1`,
        [
          jobId,
          JSON.stringify([
            {
              priorRunId: 'run-1',
              requiredNeeds: [{ needId: gated.id, askingEpoch: 1 }],
              requestedAt: gated.createdAt,
              requestedBy: APPROVER,
              enqueuedAt: null,
            },
          ]),
        ],
      );

      const migration = fs.readFileSync(
        path.resolve(
          'apps/core/src/adapters/storage/postgres/schema/migrations/20261001181904_shrink_job_permission_card_history.sql',
        ),
        'utf8',
      );
      await query(migration);
      const once = await query(
        `SELECT id, status, resolved_at, payload_json FROM pending_interactions
          WHERE kind = 'job_permission_need' AND payload_json->>'jobId' = $1 ORDER BY id`,
        [jobId],
      );
      await query(migration);
      const twice = await query(
        `SELECT id, status, resolved_at, payload_json FROM pending_interactions
          WHERE kind = 'job_permission_need' AND payload_json->>'jobId' = $1 ORDER BY id`,
        [jobId],
      );

      expect(twice.rows).toEqual(once.rows);
      const statuses = await needRowStatuses(jobId);
      expect(statuses.get(gated.id)).toBe('pending');
      for (const run of [2, 3]) {
        expect(statuses.get(byIdentity(`request-${run}`).id)).toBe('resolved');
      }
      for (const run of [4, 5, 6]) {
        expect(statuses.get(byIdentity(`request-${run}`).id)).toBe('pending');
      }
      expect(statuses.get(rule.id)).toBe('pending');
      const trimmed = (await state(jobId)).needs.find(
        (need) => need.id === rule.id,
      )!;
      expect(
        trimmed.requestSnapshots.map(({ requestId }) => requestId),
      ).toEqual([
        'snapshot-4',
        'snapshot-5',
        'snapshot-6',
        'snapshot-7',
        'snapshot-8',
      ]);
    },
  );

  it('shrinks an oversized card and settles its stale ambiguous sends', async () => {
    const jobId = 'job-oversized';
    await attach(jobId);
    const { card: seeded, needs } = await state(jobId);
    const template = seeded.revisions[0]!;
    const revisions: JobPermissionCardRevision[] = [];
    const deliveries: JobPermissionCardRecord['revisionDeliveries'] = [];
    for (let revision = 1; revision <= 10_000; revision += 1) {
      const deliveryId =
        revision === 1 ? template.deliveryId : `oversized-${revision}`;
      revisions.push({
        ...template,
        revision,
        operation: revision === 1 ? 'send' : 'edit',
        deliveryId,
        deliveryItemId: `${deliveryId}:item`,
      });
      deliveries.push({
        revision,
        deliveryId,
        status:
          revision === 10_000
            ? 'pending'
            : revision % 2 === 0
              ? 'ambiguous'
              : 'delivered',
        provider: null,
        providerMessageId: revision % 2 === 0 ? null : 'oversized-message',
        confirmedAt: null,
        reason: null,
        updatedAt: template.createdAt,
      });
    }
    // Every run's heartbeat left a budget; 25 runs waited and resumed, one
    // is waiting now.
    const pendingBudgets: JobPermissionCardRecord['pendingBudgets'] = [];
    for (let run = 1; run <= 1_026; run += 1) {
      pendingBudgets.push({
        runId: `run-${run}`,
        openCount: run === 1_026 ? 1 : 0,
        accumulatedMs: run % 40 === 0 || run === 1_026 ? 5_000 : 0,
        hostBootId: 'boot-1',
        lastMonotonicMs: run,
      });
    }
    // Every approve-and-run-again left a barrier; the last one is not yet
    // enqueued.
    const rerunBarriers: JobPermissionCardRecord['rerunBarriers'] = [];
    for (let run = 1; run <= 1_000; run += 1) {
      rerunBarriers.push({
        priorRunId: `run-${run}`,
        requiredNeeds: [
          { needId: needs[0]!.id, askingEpoch: needs[0]!.askingEpoch },
        ],
        requestedAt: template.createdAt,
        requestedBy: APPROVER,
        enqueuedAt: run === 1_000 ? null : template.createdAt,
      });
    }
    await query(
      `UPDATE pending_interactions SET payload_json = $1
        WHERE kind = 'job_permission_card' AND payload_json->>'jobId' = $2`,
      [
        {
          ...seeded,
          revision: 10_000,
          currentProviderMessageId: 'oversized-message',
          currentProviderRevision: 9_999,
          revisions,
          revisionDeliveries: deliveries,
          pendingBudgets,
          rerunBarriers,
        },
        jobId,
      ],
    );

    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/adapters/storage/postgres/schema/migrations/20261001181904_shrink_job_permission_card_history.sql',
      ),
      'utf8',
    );
    await query(migration);
    const once = (await state(jobId)).card;
    await query(migration);
    const card = (await state(jobId)).card;

    expect(card).toEqual(once);
    expect(card.revisions.map(({ revision }) => revision)).toEqual([
      1, 9_999, 10_000,
    ]);
    expect(card.revisionDeliveries.map(({ status }) => status)).toEqual([
      'delivered',
      'delivered',
      'pending',
    ]);
    expect(card.pendingBudgets.map(({ runId }) => runId)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `run-${(index + 6) * 40}`),
      'run-1026',
    ]);
    expect(card.rerunBarriers.map(({ priorRunId }) => priorRunId)).toEqual(
      Array.from({ length: 21 }, (_, index) => `run-${980 + index}`),
    );
    // The shrunk card still accepts a write through the real path.
    await expect(attach(jobId, 'run-2')).resolves.toMatchObject({
      status: 'asking',
    });
  }, 120_000);
});
