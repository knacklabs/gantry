import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { jsonbRoundTrip } from './jsonb-round-trip.js';

import {
  canonicalJobPermissionNeedIdentity,
  JobPermissionDurabilityService,
  type JobPermissionDurabilityClock,
  type JobPermissionDurabilityEffects,
  type JobPermissionDurabilityLogger,
  type JobPermissionRevalidationResult,
} from '@core/application/interactions/job-permission-durability.js';
import {
  createJobPermissionDurabilityWiring,
  revalidateJobPermissionCurrentPolicy,
} from '@core/app/bootstrap/job-permission-durability-wiring.js';
import type {
  JobPermissionCardRecord,
  JobPermissionCardDeliveryOutcome,
  JobPermissionDurabilityRepository,
  JobPermissionDurabilityState,
  JobPermissionNeedRecord,
} from '@core/domain/ports/job-permission-durability.js';
import {
  jobPermissionCardActions,
  jobPermissionCardText,
} from '@core/domain/job-permission-card-actions.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { requestPermissionApprovalViaIpc } from '@core/runner/permission-ipc-client.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';

class MemoryJobPermissionRepository implements JobPermissionDurabilityRepository {
  readonly states = new Map<string, JobPermissionDurabilityState>();
  readonly deliveries = new Map<string, JobPermissionCardDeliveryOutcome>();
  pendingRequest: Record<string, any> | null = null;
  activeLease: Record<string, any> | null = null;

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
    this.states.set(key, jsonbRoundTrip(mutation.state));
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
      .filter(
        (need) =>
          [
            'asking',
            'approved_pending_apply',
            'denied_pending_delivery',
            'handoff_pending',
          ].includes(need.state) ||
          (need.state === 'handed_off' && need.grant === 'once'),
      )
      .slice(0, input.limit ?? 100)
      .map((need) => structuredClone(need));
  }

  async listJobPermissionCardsForReconciliation(
    input: { limit?: number } = {},
  ): Promise<JobPermissionCardRecord[]> {
    return [...this.states.values()]
      .map((state) => state.card)
      .filter((card) =>
        card.revisionDeliveries.some((delivery) =>
          ['pending', 'ambiguous'].includes(delivery.status),
        ),
      )
      .slice(0, input.limit ?? 100)
      .map((card) => structuredClone(card));
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

  async findPendingInteractionByRequest() {
    return structuredClone(this.pendingRequest);
  }

  async getActiveRunLease() {
    return structuredClone(this.activeLease);
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
  failRerunCount = 0;
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
    if (this.failRerunCount > 0) {
      this.failRerunCount -= 1;
      throw new Error('rerun enqueue interrupted');
    }
  }
}

function createHarness(capacity = { maxRows: 8, maxGrantAtomsPerRow: 8 }) {
  const repository = new MemoryJobPermissionRepository();
  const effects = new TestEffects();
  const clock = new TestClock();
  const logs: Array<{
    level: 'info' | 'warn';
    context: Record<string, unknown>;
    message: string;
  }> = [];
  const logger: JobPermissionDurabilityLogger = {
    info: (context, message) => logs.push({ level: 'info', context, message }),
    warn: (context, message) => logs.push({ level: 'warn', context, message }),
  };
  const service = new JobPermissionDurabilityService(
    repository,
    effects,
    clock,
    capacity,
    logger,
  );
  return { repository, effects, clock, logs, service };
}

function attach(
  service: JobPermissionDurabilityService,
  input: {
    jobId?: string;
    label?: string;
    atoms?: string[];
    grant?: 'rule' | 'once';
    waiterId?: string;
    requestId?: string;
    runId?: string;
  } = {},
) {
  const grant = input.grant ?? 'rule';
  const atoms =
    input.atoms ?? (grant === 'once' ? [] : ['RunCommand(npm test *)']);
  const requestId = input.requestId ?? 'request-1';
  return service.attachNeed({
    appId: 'default',
    jobId: input.jobId ?? 'job-1',
    sourceAgentFolder: 'main_agent',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    canonicalIdentity:
      grant === 'once' ? requestId : canonicalJobPermissionNeedIdentity(atoms),
    displayLabel: input.label ?? atoms.join(' + '),
    grant,
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

function readState(repository: MemoryJobPermissionRepository, jobId = 'job-1') {
  return repository.getJobPermissionState({ appId: 'default', jobId });
}

function decide(
  service: JobPermissionDurabilityService,
  need: { needId: string; askingEpoch: number },
  revision: number,
  options: {
    actorRef?: string;
    jobId?: string;
    decision?: 'allow' | 'deny';
    reason?: string;
  } = {},
) {
  return service.decideCard({
    appId: 'default',
    jobId: options.jobId ?? 'job-1',
    sourceAgentFolder: 'main_agent',
    actorRef: options.actorRef ?? 'telegram:user-1',
    revision,
    decision: options.decision ?? 'allow',
    needId: need.needId,
    askingEpoch: need.askingEpoch,
    reason: options.reason,
  });
}

function legacyCardActionToken(
  callbackKey: string,
  revision: number,
  rowIndex: number | null,
  decision: 'allow' | 'deny' | 'reconsider' | 'show' | 'next',
) {
  const codes = {
    allow: 'a',
    deny: 'd',
    reconsider: 'r',
    show: 's',
    next: 'n',
  } as const;
  return `jp:${callbackKey}:${revision.toString(36)}:${rowIndex === null ? 'x' : rowIndex.toString(36)}:${codes[decision]}`;
}

async function waitForPermissionRequest(directory: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [file] = fs.existsSync(directory)
      ? fs.readdirSync(directory).filter((entry) => entry.endsWith('.json'))
      : [];
    if (file) return file;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the permission request file.');
}

async function confirmLatest(
  service: JobPermissionDurabilityService,
  repository: MemoryJobPermissionRepository,
  jobId = 'job-1',
) {
  const state = await readState(repository, jobId);
  const revision = state!.card.revisions.at(-1)!;
  repository.deliveries.set(revision.deliveryId, {
    status: 'delivered',
    provider: 'telegram',
    providerMessageId: `message:${revision.revision}`,
    deliveredAt: '2026-08-23T00:00:00.000Z',
  });
  return revision.revision;
}

it('attaches a job request with no persistable rule as a once need', async () => {
  const repository = new MemoryJobPermissionRepository();
  const service = createJobPermissionDurabilityWiring({
    repository: repository as never,
    opsRepository: {} as never,
    channelWiring: {} as never,
    getPermissionRuntimeSettings: () => ({
      agents: {},
      permissions: {},
    }),
    getToolRepository: () => undefined,
    getSkillRepository: () => undefined,
    resolveCardTarget: () => ({
      appId: 'default',
      conversationId: 'tg:job',
      threadId: null,
      agentId: 'agent:main_agent',
    }),
    enqueueRunAgain: async () => undefined,
  });

  await expect(
    service.attachRequest({
      request: {
        requestId: 'once-request-1',
        appId: 'default',
        sourceAgentFolder: 'main_agent',
        jobId: 'job-once',
        runId: 'run-once',
        runLeaseToken: 'lease-once',
        runLeaseFencingVersion: 1,
        targetJid: 'tg:job',
        toolName: 'RunCommand',
        toolInput: { command: 'npm test | tee report.txt' },
      },
      sourceAgentFolder: 'main_agent',
    }),
  ).resolves.toBe(true);

  const state = await readState(repository, 'job-once');
  expect(state!.needs[0]).toMatchObject({
    canonicalIdentity: 'once-request-1',
    grant: 'once',
    renderedGrantAtoms: [],
  });
  expect(state!.card.revisions.at(-1)!.rows[0]).toMatchObject({
    grant: 'once',
    renderedGrantAtoms: [],
  });
  expect(
    jobPermissionCardActions(
      state!.card.callbackKey,
      state!.card.revisions.at(-1)!,
    ).map((action) => action.label),
  ).toEqual(['Allow', 'Deny']);
});

it('bounds and redacts the once need label', async () => {
  const repository = new MemoryJobPermissionRepository();
  const service = createJobPermissionDurabilityWiring({
    repository: repository as never,
    opsRepository: {} as never,
    channelWiring: {} as never,
    getPermissionRuntimeSettings: () => ({
      agents: {},
      permissions: {},
    }),
    getToolRepository: () => undefined,
    getSkillRepository: () => undefined,
    resolveCardTarget: () => ({
      appId: 'default',
      conversationId: 'tg:job',
      threadId: null,
      agentId: 'agent:main_agent',
    }),
    enqueueRunAgain: async () => undefined,
  });
  const secret = 'supersecretpassword';

  await service.attachRequest({
    request: {
      requestId: 'once-request-bounded',
      appId: 'default',
      sourceAgentFolder: 'main_agent',
      jobId: 'job-once-bounded',
      runId: 'run-once-bounded',
      runLeaseToken: 'lease-once-bounded',
      runLeaseFencingVersion: 1,
      targetJid: 'tg:job',
      toolName: 'RunCommand',
      toolInput: {
        command: `printf "password=${secret}"\n  | tee ${'report'.repeat(40)}`,
      },
    },
    sourceAgentFolder: 'main_agent',
  });

  const state = await readState(repository, 'job-once-bounded');
  const label = state!.needs[0]!.displayLabel;
  expect(label).toHaveLength(160);
  expect(label).toContain('password=[REDACTED_SECRET]');
  expect(label).not.toContain(secret);
  expect(label).not.toMatch(/\s{2,}|[\r\n]/);
  expect(label.endsWith('…')).toBe(true);
  expect(state!.card.revisions.at(-1)!.rows[0]!.displayLabel).toBe(label);
  expect(
    jobPermissionCardText('job-once-bounded', state!.card.revisions.at(-1)!),
  ).toContain(`${label} (this run only)`);
});

it('replays a signed allow_once for a once need without writing a rule', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobperm-once-'));
  const repository = new MemoryJobPermissionRepository();
  const auth = createIpcAuthEnvelope('main_agent');
  const service = createJobPermissionDurabilityWiring({
    repository: repository as never,
    opsRepository: {
      getJobById: async () => ({
        workspace_key: 'main_agent',
        execution_context: { conversationJid: 'tg:job' },
      }),
    } as never,
    channelWiring: {
      isControlApproverAllowed: async () => true,
    },
    getPermissionRuntimeSettings: () => ({
      agents: { main_agent: { accessPreset: 'full' as const } },
      permissions: {},
    }),
    getToolRepository: () => undefined,
    getSkillRepository: () => undefined,
    resolveCardTarget: () => ({
      appId: 'default',
      conversationId: 'tg:job',
      threadId: null,
      agentId: 'agent:main_agent',
    }),
    enqueueRunAgain: async () => undefined,
  });
  try {
    const runnerDecision = requestPermissionApprovalViaIpc(
      {
        appId: 'default',
        agentId: 'agent:main_agent',
        chatJid: 'tg:job',
        jobId: 'job-once',
        jobRunId: 'run-once',
        jobRunLeaseToken: 'lease-once',
        jobRunLeaseFencingVersion: '1',
        ipcAuthToken: auth.authToken,
        ipcResponseVerifyKey: auth.responseVerifyKey,
        ipcResponseKeyId: auth.responseKeyId,
        permissionRequestTimeoutMs: 5_000,
        permissionLane: 'autonomous',
        permissionMode: 'ask',
        resolveWorkspaceIpcDir: (folder) => path.join(tempDir, 'ipc', folder),
      },
      {
        agentFolder: 'main_agent',
        toolName: 'RunCommand',
        toolInput: { command: 'npm test | tee report.txt' },
      },
    );
    const requestDirectory = path.join(
      tempDir,
      'ipc',
      'main_agent',
      'permission-requests',
    );
    const requestFile = await waitForPermissionRequest(requestDirectory);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDirectory, requestFile), 'utf8'),
    ) as PermissionApprovalRequest & { responseNonce: string };
    repository.pendingRequest = {
      payload: { request },
      callbackRoute: {
        ipcBaseDir: path.join(tempDir, 'ipc'),
        responseKeyId: auth.responseKeyId,
        responseNonce: request.responseNonce,
      },
    };
    repository.activeLease = {
      runId: 'run-once',
      leaseToken: 'lease-once',
      fencingVersion: 1,
    };

    await expect(
      service.attachRequest({ request, sourceAgentFolder: 'main_agent' }),
    ).resolves.toBe(true);
    const state = await readState(repository, 'job-once');
    await expect(
      service.decideCard({
        appId: 'default',
        jobId: 'job-once',
        sourceAgentFolder: 'main_agent',
        actorRef: 'operator-1',
        actorContext: { conversationJid: 'tg:job' },
        revision: state!.card.revision,
        decision: 'allow',
        batch: true,
      }),
    ).resolves.toMatchObject({ status: 'accepted' });
    await service.reconcile();

    await expect(runnerDecision).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'human_once',
      source: 'human_once',
      repeatableForFutureRuns: false,
      decisionClassification: 'user_temporary',
    });
    const settled = await readState(repository, 'job-once');
    expect(settled!.needs[0]).toMatchObject({
      state: 'applied',
      grant: 'once',
      approvedGrantAtoms: [],
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('treats a persisted need without grant as rule', async () => {
  const { repository, effects, service } = createHarness();
  const asking = await attach(service);
  const stored = repository.states.get('default:job-1')!;
  delete stored.needs[0]!.grant;
  delete stored.card.revisions[0]!.rows[0]!.grant;
  const revision = await confirmLatest(service, repository);
  await service.reconcile();
  await decide(service, asking, revision);
  await service.reconcile();

  expect(effects.grantKeys).toHaveLength(1);
  expect((await readState(repository))!.needs[0]).toMatchObject({
    state: 'applied',
    grant: 'rule',
  });
});

it('denies a once need without writing a rule', async () => {
  const { repository, effects, service } = createHarness();
  const asking = await attach(service, {
    jobId: 'job-once-deny',
    requestId: 'once-deny-request',
    grant: 'once',
    label: 'Run Command: npm test | tee report.txt',
  });
  const revision = await confirmLatest(service, repository, 'job-once-deny');
  await service.reconcile();
  await decide(service, asking, revision, {
    jobId: 'job-once-deny',
    decision: 'deny',
  });
  await service.reconcile();

  expect(effects.grantKeys).toEqual([]);
  expect(effects.responseKinds).toEqual(['denied']);
  expect(
    (await readState(repository, 'job-once-deny'))!.needs[0],
  ).toMatchObject({ state: 'denied', grant: 'once' });
});

it('settles a once need as expired when its run ended', async () => {
  const { repository, effects, clock, service } = createHarness();
  const expired = await attach(service, {
    jobId: 'job-once-expired',
    requestId: 'once-expired-request',
    runId: 'run-once-expired',
    grant: 'once',
    label: 'Run Command: npm test | tee report.txt',
  });
  await confirmLatest(service, repository, 'job-once-expired');
  await service.reconcile();

  effects.alive.set('run-once-expired', false);
  clock.nowIso = '2026-08-23T00:01:00.000Z';
  await service.reconcile();

  let state = await readState(repository, 'job-once-expired');
  expect(state!.needs[0]).toMatchObject({
    id: expired.needId,
    state: 'cancelled',
    grant: 'once',
    decidedAt: null,
    decidedBy: null,
    grantAppliedAt: null,
    expiredAt: clock.nowIso,
  });
  expect(state!.needs[0]!.waiters).toEqual([
    expect.objectContaining({ state: 'retired' }),
  ]);
  expect(state!.card.revisions.at(-1)!.rows[0]).toMatchObject({
    needId: expired.needId,
    actionEnabled: false,
    denyEnabled: false,
    expiredAt: clock.nowIso,
  });
  expect(effects.grantKeys).toEqual([]);
  expect(effects.responseKinds).toEqual([]);
  expect(effects.rerunKeys).toEqual([]);

  const fresh = await attach(service, {
    jobId: 'job-once-expired',
    waiterId: 'once-fresh-waiter',
    requestId: 'once-fresh-request',
    runId: 'run-once-fresh',
    grant: 'once',
    label: 'Run Command: npm test | tee report.txt',
  });
  expect(fresh).toMatchObject({ status: 'asking' });
  expect(fresh.needId).not.toBe(expired.needId);
  state = await readState(repository, 'job-once-expired');
  expect(state!.needs).toHaveLength(2);
  expect(state!.needs.find((need) => need.id === expired.needId)).toMatchObject(
    {
      state: 'cancelled',
      expiredAt: clock.nowIso,
    },
  );
  expect(state!.needs.find((need) => need.id === fresh.needId)).toMatchObject({
    state: 'asking',
    grant: 'once',
  });
});

it('expires a once need already handed off before the expiry sweep existed', async () => {
  const { repository, effects, clock, service } = createHarness();
  const pending = await attach(service, {
    jobId: 'job-once-handoff-pending',
    requestId: 'once-handoff-pending-request',
    runId: 'once-handoff-pending-run',
    grant: 'once',
  });
  const handedOff = await attach(service, {
    jobId: 'job-once-handed-off',
    requestId: 'once-handed-off-request',
    runId: 'once-handed-off-run',
    grant: 'once',
  });
  const pendingState = repository.states.get(
    'default:job-once-handoff-pending',
  )!;
  pendingState.needs[0]!.state = 'handoff_pending';
  pendingState.needs[0]!.waiters[0]!.state = 'handoff';
  const handedOffState = repository.states.get('default:job-once-handed-off')!;
  handedOffState.needs[0]!.state = 'handed_off';
  handedOffState.needs[0]!.waiters[0]!.state = 'handoff';

  clock.nowIso = '2026-08-23T00:01:00.000Z';
  await service.reconcile();

  for (const [jobId, needId] of [
    ['job-once-handoff-pending', pending.needId],
    ['job-once-handed-off', handedOff.needId],
  ]) {
    const state = (await readState(repository, jobId))!;
    expect(state.needs[0]).toMatchObject({
      id: needId,
      state: 'cancelled',
      expiredAt: clock.nowIso,
      waiters: [expect.objectContaining({ state: 'handoff' })],
    });
    expect(
      jobPermissionCardText(jobId, state.card.revisions.at(-1)!),
    ).toContain('Expired —');
  }
  expect(effects.responseKinds).toEqual([]);
  expect(effects.grantKeys).toEqual([]);
  expect(effects.rerunKeys).toEqual([]);
});

it('jobperm-1-t2-reconciler-crash-safe', async () => {
  const { repository, effects, service } = createHarness();
  const asking = await attach(service);
  expect(asking.status).toBe('asking');
  const renderedRevision = await confirmLatest(service, repository);
  await service.reconcile();

  const accepted = await decide(service, asking, renderedRevision);
  expect(accepted.status).toBe('accepted');

  effects.failGrantCount = 1;
  await expect(service.reconcile()).rejects.toThrow('grant write interrupted');
  let state = await readState(repository);
  expect(state!.needs[0]!.state).toBe('approved_pending_apply');

  await service.reconcile();
  state = await readState(repository);
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
  const denyRevision = await confirmLatest(service, repository);
  await service.reconcile();
  await decide(service, denied, denyRevision, {
    decision: 'deny',
    reason: 'Browser is not allowed for this job.',
  });
  effects.failResponseCount = 1;
  await expect(service.reconcile()).rejects.toThrow(
    'response delivery interrupted',
  );
  await service.reconcile();
  state = await readState(repository);
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
  await decide(service, policyChanged, policyRevision, {
    jobId: 'job-policy-change',
  });
  effects.revalidation = {
    kind: 'reask',
    displayLabel: 'Broader scope',
    grantAtoms: ['RunCommand(npm test *)', 'Browser'],
  };
  await service.reconcile();
  state = await readState(repository, 'job-policy-change');
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

  const capability = {
    capabilityId: 'acme.records.append',
    displayName: 'Acme records append',
    category: 'Records',
    risk: 'write' as const,
    can: 'Append reviewed records.',
    cannot: 'Delete records.',
    credentialSource: 'configured_access' as const,
    implementationBindings: [
      { kind: 'adapter' as const, adapterRef: 'acme.records.append' },
    ],
  };
  const request: PermissionApprovalRequest = {
    requestId: 'policy-request',
    appId: 'default',
    agentId: 'agent:main_agent',
    sourceAgentFolder: 'main_agent',
    toolName: 'example.records.append',
    toolInput: {},
    semanticCapabilityDefinitions: {
      [capability.capabilityId]: capability,
    },
    suggestions: [
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: `capability:${capability.capabilityId}` }],
      },
    ],
  };
  const revalidate = (currentCapability: typeof capability) =>
    revalidateJobPermissionCurrentPolicy({
      request,
      renderedGrantAtoms: [`capability:${capability.capabilityId}`],
      settings: {
        agents: { main_agent: { accessPreset: 'full', capabilities: [] } },
        permissions: {},
      },
      toolRepository: {
        listTools: async () => [
          {
            id: 'tool:acme-records-append',
            appId: 'default',
            name: `capability:${capability.capabilityId}`,
            status: 'active',
            inputSchema: semanticCapabilityInputSchema(currentCapability),
          },
        ],
      } as never,
      skillRepository: undefined,
    });
  await expect(revalidate(capability)).resolves.toEqual({
    kind: 'approved',
    grantAtoms: [`capability:${capability.capabilityId}`],
  });
  await expect(
    revalidate({
      ...capability,
      can: 'Append and delete reviewed records.',
      cannot: 'Access unrelated records.',
    }),
  ).resolves.toMatchObject({
    kind: 'cancelled',
    reason: expect.stringContaining('changed after the card was rendered'),
  });
});

it('q-0074-no-op-revision-after-confirm', async () => {
  const { repository, service } = createHarness();
  await attach(service);
  await confirmLatest(service, repository);
  await service.reconcile();
  await service.reconcile();

  const state = await readState(repository);
  expect(state!.card.revisions).toHaveLength(1);
  expect(
    state!.card.revisionDeliveries.filter(
      (delivery) => delivery.status === 'pending',
    ),
  ).toHaveLength(0);
});

it('logs a delivered card revision after recording it durably', async () => {
  const { logs, repository, service } = createHarness();
  await attach(service);
  const card = (await readState(repository))!.card;
  const revision = card.revisions.at(-1)!;
  await confirmLatest(service, repository);

  await service.reconcile();

  expect(logs).toEqual([
    {
      level: 'info',
      context: {
        jobId: 'job-1',
        cardId: card.id,
        revision: revision.revision,
        operation: 'send',
        provider: 'telegram',
        providerMessageId: 'message:1',
        deliveryId: revision.deliveryId,
      },
      message: 'Job permission card delivered',
    },
  ]);
});

it('logs a failed card revision after recording its reason durably', async () => {
  const { logs, repository, service } = createHarness();
  await attach(service);
  const state = await readState(repository);
  const revision = state!.card.revisions.at(-1)!;
  repository.deliveries.set(revision.deliveryId, {
    status: 'exhausted',
    reason: 'provider delivery exhausted',
  });

  await service.reconcile();

  expect(logs).toEqual([
    {
      level: 'warn',
      context: {
        jobId: 'job-1',
        cardId: state!.card.id,
        revision: revision.revision,
        operation: 'send',
        provider: 'unknown',
        providerMessageId: null,
        deliveryId: revision.deliveryId,
        reason: 'provider delivery exhausted',
      },
      message: 'Job permission card delivery failed',
    },
  ]);
});

it('replaces a stale message for a new permission need while a paging edit is pending', async () => {
  const { repository, clock, service } = createHarness({
    maxRows: 8,
    maxGrantAtomsPerRow: 2,
  });
  await attach(service, {
    atoms: ['RunCommand(a)', 'RunCommand(b)', 'RunCommand(c)'],
  });
  await confirmLatest(service, repository);
  await service.reconcile();
  clock.nowIso = '2026-08-23T00:11:00.000Z';

  const cardState = await readState(repository);
  const revision = cardState!.card.revisions.at(-1)!;
  const action = legacyCardActionToken(
    cardState!.card.callbackKey,
    revision.revision,
    0,
    'show',
  );
  await service.decideCardAction({
    actor: { actorRef: 'slack:user-1' },
    token: action,
  });
  await attach(service, {
    label: 'Browser',
    atoms: ['Browser'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });

  const state = await readState(repository);
  expect(state!.card.revisions.at(-1)!.operation).toBe('replace');
});

it('replaces when only an edit confirmation remains for the current message', async () => {
  const { repository, clock, service } = createHarness({
    maxRows: 8,
    maxGrantAtomsPerRow: 2,
  });
  await attach(service, {
    atoms: ['RunCommand(a)', 'RunCommand(b)', 'RunCommand(c)'],
  });
  await confirmLatest(service, repository);
  await service.reconcile();
  clock.nowIso = '2026-08-23T00:11:00.000Z';

  const cardState = await readState(repository);
  const revision = cardState!.card.revisions.at(-1)!;
  const action = legacyCardActionToken(
    cardState!.card.callbackKey,
    revision.revision,
    0,
    'show',
  );
  await service.decideCardAction({
    actor: { actorRef: 'slack:user-1' },
    token: action,
  });

  const edit = (await readState(repository))!.card.revisions.at(-1)!;
  repository.deliveries.set(edit.deliveryId, {
    status: 'delivered',
    provider: 'telegram',
    providerMessageId: 'message:1',
    deliveredAt: clock.nowIso,
  });
  await service.reconcile();

  const boundedState = (await readState(repository))!;
  boundedState.card.revisionDeliveries =
    boundedState.card.revisionDeliveries.filter(
      (delivery) => delivery.revision === edit.revision,
    );
  repository.states.set('default:job-1', jsonbRoundTrip(boundedState));

  await attach(service, {
    label: 'Browser',
    atoms: ['Browser'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });

  const state = await readState(repository);
  expect(state!.card.revisions.at(-1)!.operation).toBe('replace');
});

it('edits a fresh card for a newly asking permission need', async () => {
  const { repository, clock, service } = createHarness();
  await attach(service);
  await confirmLatest(service, repository);
  await service.reconcile();
  clock.nowIso = '2026-08-23T00:01:00.000Z';

  await attach(service, {
    label: 'Browser',
    atoms: ['Browser'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });

  const state = await readState(repository);
  expect(state!.card.revisions.at(-1)!.operation).toBe('edit');
});

it('edits a stale card for a scope paging change', async () => {
  const { repository, clock, service } = createHarness({
    maxRows: 8,
    maxGrantAtomsPerRow: 2,
  });
  await attach(service, {
    atoms: ['RunCommand(a)', 'RunCommand(b)', 'RunCommand(c)'],
  });
  await confirmLatest(service, repository);
  await service.reconcile();
  clock.nowIso = '2026-08-23T00:11:00.000Z';

  const state = await readState(repository);
  const revision = state!.card.revisions.at(-1)!;
  const action = legacyCardActionToken(
    state!.card.callbackKey,
    revision.revision,
    0,
    'show',
  );
  await service.decideCardAction({
    actor: { actorRef: 'slack:user-1' },
    token: action,
  });

  const updated = await readState(repository);
  expect(updated!.card.revisions.at(-1)!.operation).toBe('edit');
});

it('edits while a stale-card replacement is unconfirmed', async () => {
  const { repository, clock, service } = createHarness();
  await attach(service);
  await confirmLatest(service, repository);
  await service.reconcile();
  clock.nowIso = '2026-08-23T00:11:00.000Z';

  await attach(service, {
    label: 'Browser',
    atoms: ['Browser'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });
  let state = await readState(repository);
  expect(state!.card.revisions.at(-1)!.operation).toBe('replace');

  await attach(service, {
    label: 'FileRead',
    atoms: ['FileRead'],
    waiterId: 'waiter-3',
    requestId: 'request-3',
    runId: 'run-3',
  });

  state = await readState(repository);
  expect(state!.card.revisions.at(-1)!.operation).toBe('edit');
});

it('edits after an unconfirmed stale-card replacement and intervening edit', async () => {
  const { repository, clock, service } = createHarness();
  await attach(service);
  await confirmLatest(service, repository);
  await service.reconcile();
  clock.nowIso = '2026-08-23T00:11:00.000Z';

  await attach(service, {
    label: 'Browser',
    atoms: ['Browser'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });
  let state = await readState(repository);
  expect(state!.card.revisions.at(-1)!.operation).toBe('replace');

  await attach(service, {
    label: 'FileRead',
    atoms: ['FileRead'],
    waiterId: 'waiter-3',
    requestId: 'request-3',
    runId: 'run-3',
  });
  state = await readState(repository);
  expect(state!.card.revisions.at(-1)!.operation).toBe('edit');

  await attach(service, {
    label: 'RunCommand',
    atoms: ['RunCommand(*)'],
    waiterId: 'waiter-4',
    requestId: 'request-4',
    runId: 'run-4',
  });

  state = await readState(repository);
  expect(state!.card.revisions.at(-1)!.operation).toBe('edit');
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
  await confirmLatest(service, repository);
  await service.reconcile();
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
  await confirmLatest(service, repository);
  await service.reconcile();
  let state = await readState(repository);
  const renderedRevision = state!.card.revisions.at(-1)!;
  expect(renderedRevision.rows).toHaveLength(2);
  const allNeedIds = [first.needId, second.needId, third.needId];
  const hiddenNeedId = allNeedIds.find(
    (needId) => !renderedRevision.batchNeedIds.includes(needId),
  )!;
  expect(renderedRevision.batchNeedIds).toHaveLength(2);
  const nextPageAction = legacyCardActionToken(
    state!.card.callbackKey,
    renderedRevision.revision,
    null,
    'next',
  );
  await expect(
    service.decideCardAction({
      actor: { actorRef: 'slack:user-1' },
      token: nextPageAction,
    }),
  ).resolves.toEqual({ status: 'accepted', needIds: [hiddenNeedId] });
  state = await readState(repository);
  const nextPageRevision = state!.card.revisions.at(-1)!;
  expect(nextPageRevision).toMatchObject({
    pageStart: 2,
    hiddenRowCount: 2,
  });
  await expect(
    service.decideCardAction({
      actor: { actorRef: 'slack:user-1' },
      token: nextPageAction,
    }),
  ).resolves.toEqual({ status: 'stale' });

  await service.decideCard({
    appId: 'default',
    jobId: 'job-1',
    sourceAgentFolder: 'main_agent',
    actorRef: 'slack:user-1',
    revision: renderedRevision.revision,
    decision: 'allow',
    batch: true,
  });
  state = await readState(repository);
  expect(state!.needs.find((need) => need.id === hiddenNeedId)!.state).toBe(
    'asking',
  );
  expect(
    state!.needs
      .filter((need) => renderedRevision.batchNeedIds.includes(need.id))
      .map((need) => need.state),
  ).toEqual(['approved_pending_apply', 'approved_pending_apply']);

  await attach(service, {
    label: 'Unseen third',
    atoms: ['RunCommand(third *)'],
    waiterId: 'waiter-4',
    requestId: 'request-4',
    runId: 'run-4',
  });
  state = await readState(repository);
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
  state = await readState(repository);
  const current = state!.card.revisions.at(-1)!;
  const oversizedRow = current.rows.find(
    (row) => row.needId === oversized.needId,
  );
  expect(oversizedRow).toMatchObject({
    action: 'show_scope',
    denyEnabled: true,
    scopeFullyVisible: false,
  });
  await confirmLatest(service, repository);
  await service.reconcile();

  const showAction = legacyCardActionToken(
    state!.card.callbackKey,
    current.revision,
    current.rows.findIndex((row) => row.needId === oversized.needId),
    'show',
  );
  await expect(
    service.decideCardAction({
      actor: { actorRef: 'slack:user-1' },
      token: showAction,
    }),
  ).resolves.toEqual({ status: 'accepted', needIds: [oversized.needId] });
  state = await readState(repository);
  const fullScopeRevision = state!.card.revisions.at(-1)!;
  expect(
    fullScopeRevision.rows.find((row) => row.needId === oversized.needId),
  ).toMatchObject({
    action: 'allow_and_continue',
    scopePageStart: 2,
    scopeFullyVisible: true,
    visibleGrantAtoms: ['RunCommand(c)'],
  });
  const denyAction = jobPermissionCardActions(
    state!.card.callbackKey,
    fullScopeRevision,
  ).find((action) => action.label === 'Deny');
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
  state = await readState(repository, 'job-callback-proof');
  const callbackRevision = state!.card.revisions.at(-1)!;
  const allowAction = jobPermissionCardActions(
    state!.card.callbackKey,
    callbackRevision,
  ).find((action) => action.label === 'Allow');
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
  state = await readState(repository, 'job-callback-proof');
  expect(state!.needs[0]!.waitStartedAt).toBe(clock.nowIso);
  expect(state!.card.revisions.at(-1)!.operation).toBe('retire');
});

it('batch allow decides every decisionable card row and records rerun consent', async () => {
  const { repository, effects, service } = createHarness();
  const handedOff = await attach(service, { runId: 'handed-off-run-1' });
  await confirmLatest(service, repository);
  await service.reconcile();
  await attach(service, {
    waiterId: 'handoff-waiter',
    requestId: 'handoff-request',
    runId: 'handed-off-run-2',
  });
  await service.reconcile();
  effects.alive.set('handed-off-run-1', false);
  await service.reconcile();
  effects.alive.set('handed-off-run-2', false);
  await service.reconcile();
  await service.reconcile();
  const second = await attach(service, {
    atoms: ['RunCommand(second *)'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });
  const third = await attach(service, {
    atoms: ['RunCommand(third *)'],
    waiterId: 'waiter-3',
    requestId: 'request-3',
    runId: 'run-3',
  });
  const state = await readState(repository);
  const revision = state!.card.revisions.at(-1)!;
  expect(revision.rows).toHaveLength(3);
  expect(
    revision.rows.find((row) => row.needId === handedOff.needId)?.action,
  ).toBe('approve_and_run_again');
  const allow = jobPermissionCardActions(
    state!.card.callbackKey,
    revision,
  ).find((action) => action.label === 'Allow')!;

  await expect(
    service.decideCardAction({
      actor: { actorRef: 'telegram:user-1' },
      token: allow.token,
    }),
  ).resolves.toMatchObject({
    status: 'accepted',
    needIds: expect.arrayContaining([
      handedOff.needId,
      second.needId,
      third.needId,
    ]),
  });

  const updated = await readState(repository);
  expect(updated!.needs.map((need) => need.state)).toEqual([
    'approved_pending_apply',
    'approved_pending_apply',
    'approved_pending_apply',
  ]);
  expect(updated!.card.rerunBarriers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ priorRunId: 'handed-off-run-1' }),
    ]),
  );
});

it('batch deny denies every decisionable card row', async () => {
  const { repository, service } = createHarness();
  const first = await attach(service);
  const second = await attach(service, {
    atoms: ['RunCommand(second *)'],
    waiterId: 'waiter-2',
    requestId: 'request-2',
    runId: 'run-2',
  });
  const third = await attach(service, {
    atoms: ['RunCommand(third *)'],
    waiterId: 'waiter-3',
    requestId: 'request-3',
    runId: 'run-3',
  });
  const state = await readState(repository);
  const deny = jobPermissionCardActions(
    state!.card.callbackKey,
    state!.card.revisions.at(-1)!,
  ).find((action) => action.label === 'Deny')!;

  await expect(
    service.decideCardAction({
      actor: { actorRef: 'telegram:user-1' },
      token: deny.token,
    }),
  ).resolves.toMatchObject({
    status: 'accepted',
    needIds: expect.arrayContaining([
      first.needId,
      second.needId,
      third.needId,
    ]),
  });

  expect(
    (await readState(repository))!.needs.map((need) => need.state),
  ).toEqual([
    'denied_pending_delivery',
    'denied_pending_delivery',
    'denied_pending_delivery',
  ]);
});

it('accepts a legacy per-row token on the current revision', async () => {
  const { repository, service } = createHarness();
  const need = await attach(service);
  const state = await readState(repository);
  const revision = state!.card.revisions.at(-1)!;

  await expect(
    service.decideCardAction({
      actor: { actorRef: 'telegram:user-1' },
      token: legacyCardActionToken(
        state!.card.callbackKey,
        revision.revision,
        0,
        'allow',
      ),
    }),
  ).resolves.toEqual({ status: 'accepted', needIds: [need.needId] });
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
  let state = await readState(repository);
  expect(state!.needs[0]!.state).toBe('asking');
  expect(
    state!.needs[0]!.waiters.filter((waiter) => waiter.runId === 'run-1').map(
      (waiter) => waiter.state,
    ),
  ).toEqual(['retired', 'retired']);
  let revision = state!.card.revisions.at(-1)!;
  expect(revision.rows[0]).toMatchObject({
    action: 'allow_and_continue',
    denyEnabled: true,
  });
  expect(revision.batchNeedIds).toContain(asking.needId);

  effects.alive.set('run-2', false);
  await service.reconcile();
  state = await readState(repository);
  expect(state!.needs[0]!.state).toBe('handoff_pending');
  await service.reconcile();
  state = await readState(repository);
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

  await decide(service, asking, revision.revision, {
    actorRef: 'discord:user-1',
    decision: 'deny',
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

  state = await readState(repository);
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
  state = await readState(repository);
  expect(state!.needs[0]).toMatchObject({
    state: 'handed_off',
    askingEpoch: asking.askingEpoch + 1,
  });
  expect(state!.card.revisions.at(-1)!.rows[0]!.action).toBe(
    'approve_and_run_again',
  );
  await expect(decide(service, asking, revision.revision)).resolves.toEqual({
    status: 'already_decided',
  });

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
  state = await readState(repository, 'job-2');
  expect(state!.needs[0]!.state).toBe('handoff_pending');
  await expect(
    decide(service, late, late.cardRevision, {
      jobId: 'job-2',
    }),
  ).resolves.toMatchObject({ status: 'accepted' });
  await service.reconcile();
  state = await readState(repository, 'job-2');
  expect(state!.needs[0]!.state).toBe('approved_pending_apply');
  await service.reconcile();
  state = await readState(repository, 'job-2');
  expect(state!.needs[0]!.state).toBe('applied');
  expect(effects.rerunKeys).toEqual([]);

  const barrierFirst = await attach(service, {
    jobId: 'job-barrier',
    atoms: ['RunCommand(first *)'],
    waiterId: 'barrier-waiter-1',
    requestId: 'barrier-request-1',
    runId: 'barrier-run',
  });
  const barrierSecond = await attach(service, {
    jobId: 'job-barrier',
    atoms: ['RunCommand(second *)'],
    waiterId: 'barrier-waiter-2',
    requestId: 'barrier-request-2',
    runId: 'barrier-run',
  });
  await confirmLatest(service, repository, 'job-barrier');
  await service.reconcile();
  effects.alive.set('barrier-run', false);
  await service.reconcile();
  await service.reconcile();
  state = await readState(repository, 'job-barrier');
  revision = state!.card.revisions.at(-1)!;
  await expect(
    decide(service, barrierFirst, revision.revision, {
      jobId: 'job-barrier',
    }),
  ).resolves.toMatchObject({ status: 'accepted' });
  await service.reconcile();
  state = await readState(repository, 'job-barrier');
  expect(state!.needs[0]).toMatchObject({
    state: 'approved_pending_apply',
    grantAppliedAt: expect.any(String),
  });
  expect(effects.rerunKeys).toEqual([]);
  await expect(
    decide(service, barrierSecond, revision.revision, {
      jobId: 'job-barrier',
    }),
  ).resolves.toMatchObject({ status: 'accepted' });
  state = await readState(repository, 'job-barrier');
  expect(state!.card.rerunBarriers).toEqual([
    expect.objectContaining({
      priorRunId: 'barrier-run',
      requiredNeeds: expect.arrayContaining([
        { needId: barrierFirst.needId, askingEpoch: barrierFirst.askingEpoch },
        {
          needId: barrierSecond.needId,
          askingEpoch: barrierSecond.askingEpoch,
        },
      ]),
      enqueuedAt: null,
    }),
  ]);
  effects.failRerunCount = 1;
  await expect(service.reconcile()).rejects.toThrow(
    'rerun enqueue interrupted',
  );
  await service.reconcile();
  await service.reconcile();
  state = await readState(repository, 'job-barrier');
  expect(state!.needs.map((need) => need.state)).toEqual([
    'applied',
    'applied',
  ]);
  expect(new Set(effects.rerunKeys)).toEqual(
    new Set(['job-permission-rerun:default:job-barrier:barrier-run']),
  );

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
  state = await readState(repository, 'job-3');
  expect(state!.needs[0]).toMatchObject({
    id: expiring.needId,
    state: 'handoff_pending',
  });
  await service.reconcile();
  state = await readState(repository, 'job-3');
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
