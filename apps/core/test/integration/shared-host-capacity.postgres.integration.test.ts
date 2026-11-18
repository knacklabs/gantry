import { afterEach, describe, expect, it } from 'vitest';
import {
  computeHostCapacityPlan,
  hostExecutionSlotKey,
} from '@core/shared/host-capacity.js';
import {
  configureRunSlotBackend,
  resetSchedulerRunSlots,
  tryAcquireRunSlot,
} from '@core/jobs/concurrency.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
} from '../harness/postgres-integration-runtime.js';

const originalHostId = process.env.GANTRY_HOST_ID;
afterEach(() => {
  resetSchedulerRunSlots();
  if (originalHostId === undefined) delete process.env.GANTRY_HOST_ID;
  else process.env.GANTRY_HOST_ID = originalHostId;
});

(hasPostgresIntegrationDatabase ? describe : describe.skip)(
  'shared host capacity with real leases',
  () => {
    it('admits independent research beside long browser work, retains chat capacity and bounds racing admissions', async () => {
      const runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'mixed_capacity',
      });
      const repository = runtime.repositories.workerCoordination;
      const releases: Array<() => void> = [];
      process.env.GANTRY_HOST_ID = runtime.schemaName;
      const plan = computeHostCapacityPlan({
        queue: { maxMessageRuns: 3, maxJobRuns: 4 },
        processRole: 'all',
        cpuThreads: 4,
      });
      configureRunSlotBackend({
        repository,
        workerInstanceId: 'capacity-test',
      });
      try {
        const first = await tryAcquireRunSlot('long-browser-work', 4, {
          hostCapacity: plan.backgroundCapacity,
          hostBudgetCapacity: plan.budget,
        });
        expect(first).toBeTypeOf('function');
        if (first) releases.push(first);
        const competing = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            tryAcquireRunSlot(`research-${i}`, 4, {
              hostCapacity: plan.backgroundCapacity,
              hostBudgetCapacity: plan.budget,
            }),
          ),
        );
        const accepted = competing.filter(
          (release): release is () => void => release !== null,
        );
        releases.push(...accepted);
        expect(accepted).toHaveLength(2);
        const chat = {
          slotKey: hostExecutionSlotKey('capacity-test'),
          holderId: 'interactive-chat',
          capacity: plan.budget,
          ttlMs: 60000,
        };
        expect(await repository.acquireRunSlot(chat)).toBe(true);
        expect(
          await repository.acquireRunSlot({ ...chat, holderId: 'excess-chat' }),
        ).toBe(false);
        expect(
          await tryAcquireRunSlot('excess-background', 4, {
            hostCapacity: plan.backgroundCapacity,
            hostBudgetCapacity: plan.budget,
          }),
        ).toBeNull();
        await repository.releaseRunSlot(chat);
        // Idle chat capacity stays reserved even after a foreground turn ends.
        expect(
          await tryAcquireRunSlot('cannot-consume-last-chat-slot', 4, {
            hostCapacity: plan.backgroundCapacity,
            hostBudgetCapacity: plan.budget,
          }),
        ).toBeNull();
      } finally {
        releases.forEach((release) => release());
        // Flush fire-and-forget release queries before dropping this isolated schema.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await runtime.cleanup();
      }
    }, 60000);
  },
);
