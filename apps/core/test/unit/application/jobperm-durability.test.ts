import { expect, it } from 'vitest';

import {
  canonicalJobPermissionNeedIdentity,
  JobPermissionDurabilityService,
  type JobPermissionDurabilityClock,
  type JobPermissionDurabilityEffects,
  type JobPermissionRevalidationResult,
} from '@core/application/interactions/job-permission-durability.js';
import type {
  JobPermissionCardRecord,
  JobPermissionCardDeliveryOutcome,
  JobPermissionDurabilityRepository,
  JobPermissionDurabilityState,
  JobPermissionNeedRecord,
} from '@core/domain/ports/job-permission-durability.js';
import { jobPermissionCardActions } from '@core/domain/job-permission-card-actions.js';

class MemoryJobPermissionRepository implements JobPermissionDurabilityRepository {
  readonly states = new Map<string, JobPermissionDurabilityState>();
  readonly deliveries = new Map<string, JobPermissionCardDeliveryOutcome>();

  async mutateJobPermissionState<T>(input: {
    appId: string;
    jobId: string;
    initialCard: JobPermissionCardRecord;
    mutate: (state: JobPermissionDurabilityState) => {
      state: JobPermissionDurabilityState;
      result: T;
    };
  }): Promise<T> {
    const key = `${input.appId}:${input.jobId}`;
    const current = structuredClone(
      this.states.get(key) ?? { card: input.initialCard, needs: [] },
    );
    const mutation = input.mutate(current);
    this.states.set(key, structuredClone(mutation.state));
    for (const revision of mutation.state.card.revisions) {
      this.deliveries.set(
        revision.deliveryId,
        this.deliveries.get(revision.deliveryId) ?? { status: 'pending' },
      );
    }
    return mutation.result;
  }

  async listJobPermissionNeedsForReconciliation(
    input: {
      limit?: number;
    } = {},
  ): Promise<JobPermissionNeedRecord[]> {
    return [...this.states.values()]
      .flatMap((state) => state.needs)
      .filter((need) =>
        [
          'asking',
          'approved_pending_apply',
          'denied_pending_delivery',
          'handoff_pending',
        ].includes(need.state),
      )
      .slice(0, input.limit ?? 100)
      .map((need) => structuredClone(need));
  }

  async getJobPermissionState(input: {
    appId: string;
    jobId: string;
  }): Promise<JobPermissionDurabilityState | null> {
    const state = this.states.get(`${input.appId}:${input.jobId}`);
    return state ? structuredClone(state) : null;
  }

  async findJobPermissionStateByCallbackKey(input: {
    callbackKey: string;
  }): Promise<JobPermissionDurabilityState | null> {
    const matches = [...this.states.values()].filter(
      (state) => state.card.callbackKey === input.callbackKey,
    );
    return matches.length === 1 ? structuredClone(matches[0]!) : null;
  }

  async getJobPermissionCardDeliveryOutcome(input: {
    deliveryId: string;
  }): Promise<JobPermissionCardDeliveryOutcome | null> {
    return structuredClone(this.deliveries.get(input.deliveryId) ?? null);
  }
}

class TestClock implements JobPermissionDurabilityClock {
  nowIso = '2026-08-23T00:00:00.000Z';
  mono = 0;
  boot = 'boot-a';

  now() {
    return this.nowIso;
  }

  monotonicMs() {
    return this.mono;
  }

  hostBootId() {
    return this.boot;
  }
}

class TestEffects implements JobPermissionDurabilityEffects {
  authorized = true;
  alive = new Map<string, boolean>();
  failGrantCount = 0;
  failResponseCount = 0;
  revalidation: JobPermissionRevalidationResult | null = null;
  readonly events: string[] = [];
  readonly grantKeys: string[] = [];
  readonly responseIds: string[] = [];
  readonly responseKinds: string[] = [];
  readonly rerunKeys: string[] = [];

  async authorizeActor() {
    return this.authorized;
  }

  async releaseSlot(input: { runId: string }) {
    this.events.push(`release:${input.runId}`);
    return true;
  }

  async acquireSlot(input: { runId: string }) {
    this.events.push(`acquire:${input.runId}`);
    return true;
  }

  async isRunAlive(input: { runId: string }) {
    return this.alive.get(input.runId) ?? true;
  }

  async revalidate(input: { renderedGrantAtoms: readonly string[] }) {
    return (
      this.revalidation ?? {
        kind: 'approved' as const,
        grantAtoms: [...input.renderedGrantAtoms],
      }
    );
  }

  async persistGrant(input: { idempotencyKey: string }) {
    this.events.push(`grant:${input.idempotencyKey}`);
    this.grantKeys.push(input.idempotencyKey);
    if (this.failGrantCount > 0) {
      this.failGrantCount -= 1;
      throw new Error('grant write interrupted');
    }
  }

  async deliverWaiterResponse(input: {
    responseId: string;
    response: { kind: string };
  }) {
    this.events.push(`response:${input.responseId}`);
    this.responseIds.push(input.responseId);
    this.responseKinds.push(input.response.kind);
    if (this.failResponseCount > 0) {
      this.failResponseCount -= 1;
      throw new Error('response delivery interrupted');
    }
  }

  async enqueueRunAgain(input: { idempotencyKey: string }) {
    this.events.push(`rerun:${input.idempotencyKey}`);
    this.rerunKeys.push(input.idempotencyKey);
  }
}

function createHarness(capacity = { maxRows: 8, maxGrantAtomsPerRow: 8 }) {
  const repository = new MemoryJobPermissionRepository();
  const effects = new TestEffects();
  const clock = new TestClock();
  const service = new JobPermissionDurabilityService(
    repository,
    effects,
    clock,
    capacity,
  );
  return { repository, effects, clock, service };
}

function attach(
  service: JobPermissionDurabilityService,
  input: {
    jobId?: string;
    label?: string;
    atoms?: string[];
    waiterId?: string;
    requestId?: string;
    runId?: string;
  } = {},
) {
  const atoms = input.atoms ?? ['RunCommand(npm test *)'];
  const requestId = input.requestId ?? 'request-1';
  return service.attachNeed({
    appId: 'default',
    jobId: input.jobId ?? 'job-1',
    sourceAgentFolder: 'main_agent',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    canonicalIdentity: canonicalJobPermissionNeedIdentity(atoms),
    displayLabel: input.label ?? atoms.join(' + '),
    renderedGrantAtoms: atoms,
    requestSnapshot: {
      requestId,
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
    },
    waiter: {
      id: input.waiterId ?? 'waiter-1',
      requestId,
      runId: input.runId ?? 'run-1',
      runLeaseToken: `lease:${input.runId ?? 'run-1'}`,
      runLeaseFencingVersion: 1,
    },
  });
}

async function confirmLatest(
  service: JobPermissionDurabilityService,
  repository: MemoryJobPermissionRepository,
  jobId = 'job-1',
) {
  const state = await repository.getJobPermissionState({
    appId: 'default',
    jobId,
  });
  const revision = state!.card.revisions.at(-1)!;
  repository.deliveries.set(revision.deliveryId, {
    status: 'delivered',
    provider: 'telegram',
    providerMessageId: `message:${revision.revision}`,
    deliveredAt: '2026-08-23T00:00:00.000Z',
  });
  return revision.revision;
}

it('jobperm-1-t2-reconciler-crash-safe', async () => {
  const { repository, effects, service } = createHarness();
  const asking = await attach(service);
  expect(asking.status).toBe('asking');
  const renderedRevision = await confirmLatest(service, repository);
  await service.reconcile();

  const accepted = await service.decideCard({
    appId: 'default',
    jobId: 'job-1',
    sourceAgentFolder: 'main_agent',
    actorRef: 'telegram:user-1',
    revision: renderedRevision,
    decision: 'allow',
    needId: asking.needId,
    askingEpoch: asking.askingEpoch,
  });
  expect(accepted.status).toBe('accepted');

  effects.failGrantCount = 1;
  await expect(service.reconcile()).rejects.toThrow('grant write interrupted');
  let state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs[0]!.state).toBe('approved_pending_apply');

  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs[0]!.state).toBe('applied');
  expect(new Set(effects.grantKeys).size).toBe(1);
  expect(new Set(effects.responseIds).size).toBe(1);
  expect(
    effects.events.findIndex((event) => event === 'release:run-1'),
  ).toBeLessThan(
    effects.events.findIndex((event) => event === 'acquire:run-1'),
  );
  expect(
    effects.events.findIndex((event) => event === 'acquire:run-1'),
  ).toBeLessThan(
    effects.events.findIndex((event) => event.startsWith('response:')),
  );

  const denied = await attach(service, {
    label: 'Browser',
    atoms: ['Browser'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });
  expect(denied.status).toBe('asking');
  const denyRevision = await confirmLatest(service, repository);
  await service.reconcile();
  await service.decideCard({
    appId: 'default',
    jobId: 'job-1',
    sourceAgentFolder: 'main_agent',
    actorRef: 'telegram:user-1',
    revision: denyRevision,
    decision: 'deny',
    needId: denied.needId,
    askingEpoch: denied.askingEpoch,
    reason: 'Browser is not allowed for this job.',
  });
  effects.failResponseCount = 1;
  await expect(service.reconcile()).rejects.toThrow(
    'response delivery interrupted',
  );
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs.find((need) => need.id === denied.needId)).toMatchObject({
    state: 'denied',
    denialReason: 'Browser is not allowed for this job.',
  });

  const policyChanged = await attach(service, {
    jobId: 'job-policy-change',
    waiterId: 'policy-waiter',
    requestId: 'policy-request',
    runId: 'policy-run',
  });
  const policyRevision = await confirmLatest(
    service,
    repository,
    'job-policy-change',
  );
  await service.reconcile();
  await service.decideCard({
    appId: 'default',
    jobId: 'job-policy-change',
    sourceAgentFolder: 'main_agent',
    actorRef: 'telegram:user-1',
    revision: policyRevision,
    decision: 'allow',
    needId: policyChanged.needId,
    askingEpoch: policyChanged.askingEpoch,
  });
  effects.revalidation = {
    kind: 'reask',
    displayLabel: 'Broader scope',
    grantAtoms: ['RunCommand(npm test *)', 'Browser'],
  };
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-policy-change',
  });
  expect(state!.needs[0]).toMatchObject({
    state: 'asking',
    askingEpoch: policyChanged.askingEpoch + 1,
    renderedGrantAtoms: ['RunCommand(npm test *)', 'Browser'],
    approvedGrantAtoms: null,
    waitStartedAt: null,
  });
  expect(state!.needs[0]!.waiters[0]).toMatchObject({
    state: 'awaiting_card_delivery',
    slotReleased: true,
  });
  effects.revalidation = null;
});

it('jobperm-1-t2-living-card-revision-bound', async () => {
  const { repository, effects, clock, service } = createHarness({
    maxRows: 2,
    maxGrantAtomsPerRow: 2,
  });
  const first = await attach(service, {
    label: 'First',
    atoms: ['RunCommand(first *)'],
  });
  const second = await attach(service, {
    label: 'Second',
    atoms: ['RunCommand(second *)'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });
  const third = await attach(service, {
    label: 'Unseen third',
    atoms: ['RunCommand(third *)'],
    waiterId: 'waiter-3',
    requestId: 'request-3',
    runId: 'run-3',
  });
  let state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  const renderedRevision = state!.card.revisions.at(-1)!;
  expect(state!.card.id).toMatch(/^job-permission-card:/);
  expect(state!.card.callbackKey).toMatch(/^[a-f0-9]{24}$/);
  expect(renderedRevision.rows).toHaveLength(2);
  expect(renderedRevision.operation).toBe('replace');
  expect(renderedRevision.hiddenRowCount).toBe(1);
  const allNeedIds = [first.needId, second.needId, third.needId];
  const hiddenNeedId = allNeedIds.find(
    (needId) => !renderedRevision.batchNeedIds.includes(needId),
  )!;
  expect(renderedRevision.batchNeedIds).toHaveLength(2);

  await service.decideCard({
    appId: 'default',
    jobId: 'job-1',
    sourceAgentFolder: 'main_agent',
    actorRef: 'slack:user-1',
    revision: renderedRevision.revision,
    decision: 'allow',
    batch: true,
  });
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs.find((need) => need.id === hiddenNeedId)!.state).toBe(
    'asking',
  );
  expect(
    state!.needs
      .filter((need) => renderedRevision.batchNeedIds.includes(need.id))
      .map((need) => need.state),
  ).toEqual(['approved_pending_apply', 'approved_pending_apply']);

  const coalesced = await attach(service, {
    label: 'Unseen third',
    atoms: ['RunCommand(third *)'],
    waiterId: 'waiter-4',
    requestId: 'request-4',
    runId: 'run-4',
  });
  expect(coalesced.needId).toBe(third.needId);
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs).toHaveLength(3);
  expect(
    state!.needs.find((need) => need.id === third.needId)!.waiters,
  ).toHaveLength(2);

  const oversized = await attach(service, {
    label: 'Large compound',
    atoms: ['RunCommand(a)', 'RunCommand(b)', 'RunCommand(c)'],
    waiterId: 'waiter-5',
    requestId: 'request-5',
    runId: 'run-5',
  });
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  const current = state!.card.revisions.at(-1)!;
  const oversizedRow = current.rows.find(
    (row) => row.needId === oversized.needId,
  );
  expect(oversizedRow).toMatchObject({
    action: 'show_scope',
    actionEnabled: true,
    denyEnabled: true,
    scopeFullyVisible: false,
  });
  expect(current.batchNeedIds).not.toContain(oversized.needId);
  await confirmLatest(service, repository);
  await service.reconcile();
  expect(effects.events).toContain('release:run-5');

  const showAction = jobPermissionCardActions(
    state!.card.callbackKey,
    current,
  ).find((action) => action.label === 'Show full scope: Large compound');
  expect(showAction).toBeDefined();
  await expect(
    service.decideCardAction({
      actor: { actorRef: 'slack:user-1' },
      token: showAction!.token,
    }),
  ).resolves.toEqual({ status: 'accepted', needIds: [oversized.needId] });
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  const fullScopeRevision = state!.card.revisions.at(-1)!;
  expect(
    fullScopeRevision.rows.find((row) => row.needId === oversized.needId),
  ).toMatchObject({
    action: 'allow_and_continue',
    scopeFullyVisible: true,
    visibleGrantAtoms: ['RunCommand(a)', 'RunCommand(b)', 'RunCommand(c)'],
  });
  expect(fullScopeRevision.batchNeedIds).toContain(oversized.needId);

  const denyAction = jobPermissionCardActions(
    state!.card.callbackKey,
    fullScopeRevision,
  ).find((action) => action.label === 'Deny: Large compound');
  expect(denyAction).toBeDefined();
  effects.authorized = false;
  await expect(
    service.decideCardAction({
      actor: { actorRef: 'slack:intruder' },
      token: denyAction!.token,
    }),
  ).resolves.toEqual({ status: 'unauthorized' });

  effects.authorized = true;
  const callbackProved = await attach(service, {
    jobId: 'job-callback-proof',
    waiterId: 'callback-waiter',
    requestId: 'callback-request',
    runId: 'callback-run',
  });
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-callback-proof',
  });
  const callbackRevision = state!.card.revisions.at(-1)!;
  const allowAction = jobPermissionCardActions(
    state!.card.callbackKey,
    callbackRevision,
  ).find((action) => action.label.startsWith('Allow:'));
  await expect(
    service.decideCardAction({
      actor: { actorRef: 'slack:user-1' },
      providerMessageId: '1712345.6789',
      token: allowAction!.token,
    }),
  ).resolves.toEqual({
    status: 'accepted',
    needIds: [callbackProved.needId],
  });
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-callback-proof',
  });
  expect(state!.card.currentProviderMessageId).toBe('1712345.6789');
  expect(state!.needs[0]!.waitStartedAt).toBe(clock.nowIso);
  expect(state!.card.revisions.at(-1)!.operation).toBe('retire');
});

it('jobperm-1-t2-handoff-and-deny-memory', async () => {
  const { repository, effects, clock, service } = createHarness();
  const asking = await attach(service);
  await confirmLatest(service, repository);
  await service.reconcile();
  await attach(service, {
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-1',
  });
  await attach(service, {
    waiterId: 'waiter-3',
    requestId: 'request-3',
    runId: 'run-2',
  });
  await service.reconcile();

  clock.mono = 100;
  expect(
    await service.recordPendingHeartbeat({
      appId: 'default',
      jobId: 'job-1',
      sourceAgentFolder: 'main_agent',
      runId: 'run-1',
    }),
  ).toBe(100);
  clock.mono = 150;
  expect(
    await service.recordPendingHeartbeat({
      appId: 'default',
      jobId: 'job-1',
      sourceAgentFolder: 'main_agent',
      runId: 'run-1',
    }),
  ).toBe(150);
  clock.boot = 'boot-b';
  clock.mono = 10;
  expect(
    await service.recordPendingHeartbeat({
      appId: 'default',
      jobId: 'job-1',
      sourceAgentFolder: 'main_agent',
      runId: 'run-1',
    }),
  ).toBe(150);
  clock.mono = 5;
  expect(
    await service.pendingLeaseExtensionMs({
      appId: 'default',
      jobId: 'job-1',
      runId: 'run-1',
    }),
  ).toBe(150);
  expect(
    await service.recordPendingHeartbeat({
      appId: 'default',
      jobId: 'job-1',
      sourceAgentFolder: 'main_agent',
      runId: 'run-1',
    }),
  ).toBe(150);
  clock.mono = 20;
  expect(
    await service.recordPendingHeartbeat({
      appId: 'default',
      jobId: 'job-1',
      sourceAgentFolder: 'main_agent',
      runId: 'run-1',
    }),
  ).toBe(160);

  effects.alive.set('run-1', false);
  await service.reconcile();
  let state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs[0]!.state).toBe('asking');
  expect(
    state!.needs[0]!.waiters.filter((waiter) => waiter.runId === 'run-1').map(
      (waiter) => waiter.state,
    ),
  ).toEqual(['retired', 'retired']);
  expect(state!.needs[0]!.requestSnapshots).toHaveLength(3);
  let revision = state!.card.revisions.at(-1)!;
  expect(revision.rows[0]).toMatchObject({
    action: 'allow_and_continue',
    denyEnabled: true,
  });
  expect(revision.batchNeedIds).toContain(asking.needId);

  effects.alive.set('run-2', false);
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs[0]!.state).toBe('handoff_pending');
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs[0]!.state).toBe('handed_off');
  revision = state!.card.revisions.at(-1)!;
  expect(revision.rows[0]).toMatchObject({
    action: 'approve_and_run_again',
    denyEnabled: true,
  });
  await expect(
    attach(service, {
      waiterId: 'handoff-waiter',
      requestId: 'handoff-request',
      runId: 'handoff-run',
    }),
  ).resolves.toMatchObject({ status: 'handoff', needId: asking.needId });

  await service.decideCard({
    appId: 'default',
    jobId: 'job-1',
    sourceAgentFolder: 'main_agent',
    actorRef: 'discord:user-1',
    revision: revision.revision,
    decision: 'deny',
    needId: asking.needId,
    askingEpoch: asking.askingEpoch,
    reason: 'No command access for this job.',
  });
  await service.reconcile();
  expect(
    await attach(service, {
      waiterId: 'waiter-later',
      requestId: 'request-later',
      runId: 'run-later',
    }),
  ).toMatchObject({
    status: 'denied',
    reason: 'No command access for this job.',
  });

  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  revision = state!.card.revisions.at(-1)!;
  expect(revision.rows[0]!.action).toBe('reconsider');
  await service.reconsider({
    appId: 'default',
    jobId: 'job-1',
    sourceAgentFolder: 'main_agent',
    actorRef: 'discord:user-1',
    revision: revision.revision,
    needId: asking.needId,
    askingEpoch: asking.askingEpoch,
  });
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-1',
  });
  expect(state!.needs[0]).toMatchObject({
    state: 'handed_off',
    askingEpoch: asking.askingEpoch + 1,
  });
  expect(state!.needs[0]!.requestSnapshots).toHaveLength(4);
  expect(state!.card.revisions.at(-1)!.rows[0]!.action).toBe(
    'approve_and_run_again',
  );
  await expect(
    service.decideCard({
      appId: 'default',
      jobId: 'job-1',
      sourceAgentFolder: 'main_agent',
      actorRef: 'discord:user-1',
      revision: revision.revision,
      decision: 'allow',
      needId: asking.needId,
      askingEpoch: asking.askingEpoch,
    }),
  ).resolves.toEqual({ status: 'already_decided' });

  const late = await attach(service, {
    jobId: 'job-2',
    waiterId: 'late-waiter',
    requestId: 'late-request',
    runId: 'late-run',
  });
  await confirmLatest(service, repository, 'job-2');
  await service.reconcile();
  effects.alive.set('late-run', false);
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-2',
  });
  expect(state!.needs[0]!.state).toBe('handoff_pending');
  await expect(
    service.decideCard({
      appId: 'default',
      jobId: 'job-2',
      sourceAgentFolder: 'main_agent',
      actorRef: 'discord:user-1',
      revision: late.cardRevision,
      decision: 'allow',
      needId: late.needId,
      askingEpoch: late.askingEpoch,
    }),
  ).resolves.toMatchObject({ status: 'accepted' });
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-2',
  });
  expect(state!.needs[0]!.state).toBe('approved_pending_apply');
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-2',
  });
  expect(state!.needs[0]!.state).toBe('applied');
  expect(effects.rerunKeys).toEqual([
    'job-permission-rerun:default:job-2:late-run',
  ]);
  await service.reconcile();
  expect(effects.rerunKeys).toHaveLength(1);

  const expiring = await attach(service, {
    jobId: 'job-3',
    waiterId: 'expiring-waiter',
    requestId: 'expiring-request',
    runId: 'expiring-run',
  });
  await confirmLatest(service, repository, 'job-3');
  await service.reconcile();
  clock.nowIso = '2026-08-24T00:00:00.000Z';
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-3',
  });
  expect(state!.needs[0]).toMatchObject({
    id: expiring.needId,
    state: 'handoff_pending',
  });
  await service.reconcile();
  state = await repository.getJobPermissionState({
    appId: 'default',
    jobId: 'job-3',
  });
  expect(state!.needs[0]!.state).toBe('handed_off');
  expect(effects.responseKinds).toContain('setup_required');
  const expiringResponseId = state!.needs[0]!.waiters[0]!.responseId;
  expect(
    effects.events.findIndex((event) => event === 'acquire:expiring-run'),
  ).toBeLessThan(
    effects.events.findIndex(
      (event) => event === `response:${expiringResponseId}`,
    ),
  );
});
