import { PgBoss, type Job as PgBossJob } from 'pg-boss';

import type { ToolchainBakeQueuePort } from './toolchain-bake-enqueue.js';
import {
  executeToolchainBake,
  type ToolchainBakeExecutorDeps,
} from './toolchain-bake-executor.js';

const BAKE_QUEUE = 'gantry.toolchain_bake';
const BAKE_QUEUE_DEAD_LETTER = 'gantry.toolchain_bake.dead_letter';

export interface ToolchainBakeSenderOptions {
  connectionString: string;
  schema?: string;
  applicationName?: string;
}

/**
 * Send-only toolchain bake enqueue port. Opens pg-boss, sends the bake job with
 * the manifest-hash singleton key (matching {@link ToolchainBakeQueue}), and
 * closes — it registers NO worker. Used by `gantry artifacts quarantine rebake`,
 * which only needs to re-queue a bake for a running fleet worker to claim.
 */
export class ToolchainBakeSender implements ToolchainBakeQueuePort {
  private boss: PgBoss | null = null;

  constructor(private readonly options: ToolchainBakeSenderOptions) {}

  async start(): Promise<void> {
    if (this.boss) return;
    const boss = new PgBoss({
      connectionString: this.options.connectionString,
      schema: this.options.schema ?? 'pgboss',
      createSchema: true,
      migrate: true,
      application_name:
        this.options.applicationName ?? 'gantry-toolchain-bake-sender',
    });
    await boss.start();
    await boss.createQueue(BAKE_QUEUE_DEAD_LETTER, {
      policy: 'standard',
      retentionSeconds: 14 * 24 * 60 * 60,
    });
    await boss.createQueue(BAKE_QUEUE, {
      policy: 'standard',
      retryLimit: 0,
      deadLetter: BAKE_QUEUE_DEAD_LETTER,
      retentionSeconds: 14 * 24 * 60 * 60,
    });
    this.boss = boss;
  }

  async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    await boss?.stop({ graceful: true, close: true, timeout: 10_000 });
  }

  async enqueueBake(input: {
    dependencyId: string;
    manifestHash: string;
  }): Promise<void> {
    const boss = this.boss;
    if (!boss) throw new Error('Toolchain bake sender is not running');
    await boss.send(
      BAKE_QUEUE,
      { dependencyId: input.dependencyId, manifestHash: input.manifestHash },
      { singletonKey: input.manifestHash, retryLimit: 0 },
    );
  }
}

interface ToolchainBakePayload {
  dependencyId: string;
  manifestHash: string;
}

export interface ToolchainBakeQueueOptions {
  connectionString: string;
  schema?: string;
  applicationName?: string;
  logError?: (context: Record<string, unknown>, message: string) => void;
  logInfo?: (context: Record<string, unknown>, message: string) => void;
}

/**
 * pg-boss-backed toolchain bake queue. A bake is a job like any other: it is
 * enqueued with a singleton key on the manifest hash (so a repeated enqueue for
 * the same manifest collapses to one in-flight job), claimed at-most-once by a
 * registered worker, and its status writes are fenced by the runtime_dependency
 * row status CAS inside {@link executeToolchainBake}. Started ONLY in fleet
 * mode; workstation never bakes (local installs are unchanged).
 *
 * Stoppable: {@link stop} grace-stops pg-boss so tests and drains exit cleanly.
 */
export class ToolchainBakeQueue implements ToolchainBakeQueuePort {
  private boss: PgBoss | null = null;

  constructor(
    private readonly executorDeps: ToolchainBakeExecutorDeps,
    private readonly options: ToolchainBakeQueueOptions,
  ) {}

  async start(): Promise<void> {
    if (this.boss) return;
    const boss = new PgBoss({
      connectionString: this.options.connectionString,
      schema: this.options.schema ?? 'pgboss',
      createSchema: true,
      migrate: true,
      application_name: this.options.applicationName ?? 'gantry-toolchain-bake',
    });
    boss.on('error', (err) => {
      this.options.logError?.({ err }, 'toolchain bake queue error');
    });
    await boss.start();
    this.boss = boss;
    await boss.createQueue(BAKE_QUEUE_DEAD_LETTER, {
      policy: 'standard',
      retentionSeconds: 14 * 24 * 60 * 60,
    });
    await boss.createQueue(BAKE_QUEUE, {
      policy: 'standard',
      retryLimit: 0,
      deadLetter: BAKE_QUEUE_DEAD_LETTER,
      retentionSeconds: 14 * 24 * 60 * 60,
    });
    await boss.work<ToolchainBakePayload>(
      BAKE_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      (jobs) => this.processJobs(jobs),
    );
  }

  /**
   * Drain decision (deliberate): stop does NOT await an in-flight bake beyond
   * pg-boss's short grace window. The default drain deadline (120s) is shorter
   * than the install timeout (5 min), so waiting could never guarantee
   * completion — a drain mid-install strands the row at `baking` and the
   * `ToolchainBakeReaper` on a live worker CAS-resets it to `queued` and
   * re-enqueues within the reap threshold. Accepting the strand keeps shutdown
   * fast and bounded instead of holding the deploy hostage to npm.
   */
  async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    await boss?.stop({ graceful: true, close: true, timeout: 10_000 });
  }

  async enqueueBake(input: {
    dependencyId: string;
    manifestHash: string;
  }): Promise<void> {
    const boss = this.boss;
    if (!boss) throw new Error('Toolchain bake queue is not running');
    await boss.send(
      BAKE_QUEUE,
      { dependencyId: input.dependencyId, manifestHash: input.manifestHash },
      {
        // Manifest-hash singleton: a repeated enqueue collapses to one job.
        singletonKey: input.manifestHash,
        retryLimit: 0,
      },
    );
  }

  private async processJobs(
    jobs: PgBossJob<ToolchainBakePayload>[],
  ): Promise<void> {
    for (const job of jobs) {
      const payload = job.data;
      if (!payload?.dependencyId) continue;
      try {
        const outcome = await executeToolchainBake(this.executorDeps, {
          dependencyId: payload.dependencyId,
        });
        this.options.logInfo?.(
          { dependencyId: payload.dependencyId, outcome: outcome.result },
          'Toolchain bake processed',
        );
      } catch (err) {
        this.options.logError?.(
          { err, dependencyId: payload.dependencyId },
          'Toolchain bake crashed before completion',
        );
      }
    }
  }
}
