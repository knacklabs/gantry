import { describe, expect, it } from 'vitest';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
} from '@core/domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '@core/domain/ports/repositories.js';
import type { WorkerRegistryRepository } from '@core/domain/ports/worker-coordination.js';
import type { Job } from '@core/domain/types.js';
import { CapabilityStarvationAlerter } from '@core/jobs/capability-starvation.js';
import { scanCapabilityStarvation } from '@core/jobs/capability-starvation-scan.js';
import { toolchainCapabilityId } from '@core/jobs/worker-capability-reconciler.js';

const NOW_MS = Date.parse('2026-06-11T12:00:00.000Z');

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Daily',
    prompt: 'p',
    model: null,
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    status: 'active',
    session_id: null,
    thread_id: null,
    workspace_key: 'agent:a',
    created_by: 'agent',
    created_at: '2026-06-11T00:00:00.000Z',
    updated_at: '2026-06-11T00:00:00.000Z',
    // 10 minutes overdue (> 5 min threshold).
    next_run: '2026-06-11T11:50:00.000Z',
    last_run: null,
    silent: false,
    cleanup_after_ms: 86400000,
    timeout_ms: 300000,
    max_retries: 3,
    retry_backoff_ms: 5000,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  };
}

function depsRepo(rows: RuntimeDependency[]): RuntimeDependencyRepository {
  return {
    createRuntimeDependency: async () => {
      throw new Error('unused');
    },
    getRuntimeDependency: async () => null,
    getRuntimeDependencyByManifestHash: async () => null,
    listRuntimeDependencies: async () => rows,
    updateRuntimeDependencyStatus: async () => true,
  };
}

const noSkills: SkillCatalogRepository = {
  getSkill: async () => null,
  listSkills: async () => [],
  saveSkill: async () => {},
  saveAgentSkillBinding: async () => {},
  disableAgentSkillBinding: async () => null,
  listAgentSkillBindings: async () => [],
  listAgentSkillBindingsForAgents: async () => [],
  listEnabledSkillsForAgent: async () => [],
} as unknown as SkillCatalogRepository;

function workerRegistry(active: string[][]): WorkerRegistryRepository {
  return {
    registerWorker: async () => {},
    heartbeatWorker: async () => true,
    markStaleWorkersUnhealthy: async () => [],
    listActiveWorkerCapabilities: async () => active,
    getWorker: async () => null,
    listWorkers: async () => [],
    advertiseWorkerCapabilities: async () => true,
  };
}

function toolchainDep(manifestHash: string): RuntimeDependency {
  return {
    id: 'dep-1',
    appId: 'default',
    manifestHash,
    requestedPackages: ['left-pad@1.3.0'],
    status: 'uploaded',
    artifact: null,
    failureReason: null,
    requestedByAgentId: 'agent:a',
    approvedByConversationId: null,
    approvedAt: null,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
  };
}

function makeAlerter() {
  const events: unknown[] = [];
  const alerter = new CapabilityStarvationAlerter({
    publishRuntimeEvent: async (event) => {
      events.push(event);
    },
    now: () => NOW_MS,
  });
  return { alerter, events };
}

describe('scanCapabilityStarvation', () => {
  it('alerts an overdue job whose required set no active worker satisfies', async () => {
    const { alerter, events } = makeAlerter();
    const result = await scanCapabilityStarvation(
      {
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([['browser']]),
        alerter,
        now: () => NOW_MS,
      },
      [job()],
    );
    expect(result.starved).toBe(1);
    expect(result.alerted).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('does not alert when an active worker can satisfy the set', async () => {
    const { alerter, events } = makeAlerter();
    const cap = toolchainCapabilityId('sha256:h1');
    const result = await scanCapabilityStarvation(
      {
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([[cap]]),
        alerter,
        now: () => NOW_MS,
      },
      [job()],
    );
    expect(result.starved).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('ignores jobs that are not yet overdue past the threshold', async () => {
    const { alerter } = makeAlerter();
    const result = await scanCapabilityStarvation(
      {
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([['browser']]),
        alerter,
        now: () => NOW_MS,
      },
      [job({ next_run: '2026-06-11T11:58:00.000Z' })],
    );
    expect(result.scanned).toBe(0);
  });

  it('ignores jobs with no fleet-distributed required capabilities', async () => {
    const { alerter } = makeAlerter();
    const result = await scanCapabilityStarvation(
      {
        skills: noSkills,
        runtimeDependencies: depsRepo([]),
        workerRegistry: workerRegistry([['browser']]),
        alerter,
        now: () => NOW_MS,
      },
      [job()],
    );
    expect(result.scanned).toBe(1);
    expect(result.starved).toBe(0);
  });

  it('dedupes repeated scans of the same starved job', async () => {
    const { alerter, events } = makeAlerter();
    const deps = {
      skills: noSkills,
      runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
      workerRegistry: workerRegistry([['browser']]),
      alerter,
      now: () => NOW_MS,
    };
    await scanCapabilityStarvation(deps, [job()]);
    await scanCapabilityStarvation(deps, [job()]);
    expect(events).toHaveLength(1);
  });

  it('pauses a starved job through the injected readiness pause hook', async () => {
    const { alerter } = makeAlerter();
    const pausedJobIds: string[] = [];
    const result = await scanCapabilityStarvation(
      {
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([['browser']]),
        alerter,
        pauseStarvedJob: async (starved) => {
          pausedJobIds.push(starved.id);
          return true;
        },
        now: () => NOW_MS,
      },
      [job()],
    );
    expect(result.starved).toBe(1);
    expect(result.paused).toBe(1);
    expect(pausedJobIds).toEqual(['job-1']);
  });

  it('does not invoke the pause hook for a satisfiable job', async () => {
    const { alerter } = makeAlerter();
    const cap = toolchainCapabilityId('sha256:h1');
    let pauseCalls = 0;
    const result = await scanCapabilityStarvation(
      {
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([[cap]]),
        alerter,
        pauseStarvedJob: async () => {
          pauseCalls += 1;
          return true;
        },
        now: () => NOW_MS,
      },
      [job()],
    );
    expect(result.starved).toBe(0);
    expect(result.paused).toBe(0);
    expect(pauseCalls).toBe(0);
  });

  it('retries the pause on a later pass even when the alert deduped', async () => {
    const { alerter } = makeAlerter();
    let pauseCalls = 0;
    const deps = {
      skills: noSkills,
      runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
      workerRegistry: workerRegistry([['browser']]),
      alerter,
      // Pause keeps failing (e.g. transient DB error inside the pause path):
      // the job stays active and must be retried next pass.
      pauseStarvedJob: async () => {
        pauseCalls += 1;
        return false;
      },
      now: () => NOW_MS,
    };
    const first = await scanCapabilityStarvation(deps, [job()]);
    const second = await scanCapabilityStarvation(deps, [job()]);
    expect(first.alerted).toBe(1);
    expect(second.alerted).toBe(0);
    expect(pauseCalls).toBe(2);
    expect(second.paused).toBe(0);
  });

  it('survives a pause hook that throws and still reports the starved job', async () => {
    const { alerter } = makeAlerter();
    const result = await scanCapabilityStarvation(
      {
        skills: noSkills,
        runtimeDependencies: depsRepo([toolchainDep('sha256:h1')]),
        workerRegistry: workerRegistry([['browser']]),
        alerter,
        pauseStarvedJob: async () => {
          throw new Error('pause path unavailable');
        },
        now: () => NOW_MS,
      },
      [job()],
    );
    expect(result.starved).toBe(1);
    expect(result.alerted).toBe(1);
    expect(result.paused).toBe(0);
  });
});
