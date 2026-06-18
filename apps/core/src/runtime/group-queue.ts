import { ChildProcess } from 'child_process';

import { logger } from '../infrastructure/logging/logger.js';
import {
  unavailableContinuationDelivery,
  type ContinuationDelivery,
  type ContinuationTarget,
} from './continuation-delivery.js';
import { stopActiveGroupRun } from './group-queue-stop.js';
import {
  normalizeThreadQueueId,
  parseThreadQueueKey,
} from '../shared/thread-queue-key.js';
import type { PooledWarmWorkerRun } from './agent-spawn-types.js';
import type { WorkerInventoryQueueSnapshot } from './worker-inventory-snapshot.js';

type QueueKind = 'message' | 'task';
type ContinuationOptions = {
  threadId?: string | null;
  senderUserIds?: readonly string[] | null;
};
type RegisterProcessOptions = {
  requiredContinuationUserId?: string | null;
  pooledWarmWorker?: PooledWarmWorkerRun;
};
type ContinuationHandler = () => void;

interface QueuedTask {
  id: string;
  kind: QueueKind;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const MAX_MESSAGE_RUNS = 3;
const MAX_JOB_RUNS = 4;

export interface GroupQueuePolicy {
  maxRetries: number;
  baseRetryMs: number;
  maxMessageRuns: number;
  maxJobRuns: number;
}

export interface GroupQueueOptions {
  maxRetries?: number;
  baseRetryMs?: number;
  maxMessageRuns?: number;
  maxJobRuns?: number;
  setTimeoutFn?: typeof setTimeout;
  /**
   * Carrier for continuation follow-ups + close signals. The queue starts with
   * a fail-closed carrier until the socket server injects the live event
   * transport via {@link GroupQueue.setContinuationDelivery}.
   */
  continuationDelivery?: ContinuationDelivery;
  /**
   * I-1 (GANTRY_IPC_SHUTDOWN_KILL, default off): when true, {@link GroupQueue.shutdown}
   * SIGKILLs any tracked runner process still alive AFTER the grace window
   * (deterministic shutdown). When false (default) such stragglers are merely
   * detached and left to next-boot recovery — today's exact behavior.
   */
  killStragglersAfterGrace?: boolean;
  onMessageRunStart?: (groupJid: string) => (() => void) | void;
}

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskRun: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  runHandle: string | null;
  groupFolder: string | null;
  threadId: string | null;
  requiredContinuationUserId: string | null;
  pooledWarmWorker: PooledWarmWorkerRun | null;
  pooledContinuationActive: boolean;
  retryCount: number;
  continuationHandler: ContinuationHandler | null;
}

export class GroupQueue {
  private readonly policy: GroupQueuePolicy;
  private readonly setTimeoutFn: typeof setTimeout;
  private groups = new Map<string, GroupState>();
  private stopAliases = new Map<string, Set<string>>();
  private activeMessageCount = 0;
  private activeTaskCount = 0;
  private waitingMessageGroups: string[] = [];
  private waitingTaskGroups: string[] = [];
  private continuationSequence = 0;
  private continuationDelivery: ContinuationDelivery;
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private activeRuns = new Set<Promise<void>>();
  private readonly killStragglersAfterGrace: boolean;
  private readonly onMessageRunStart?: (
    groupJid: string,
  ) => (() => void) | void;

  constructor(options: GroupQueueOptions = {}) {
    this.policy = {
      maxRetries: normalizeNonNegativeInteger(options.maxRetries, MAX_RETRIES),
      baseRetryMs: normalizeNonNegativeInteger(
        options.baseRetryMs,
        BASE_RETRY_MS,
      ),
      maxMessageRuns: normalizePositiveInteger(
        options.maxMessageRuns,
        MAX_MESSAGE_RUNS,
      ),
      maxJobRuns: normalizePositiveInteger(options.maxJobRuns, MAX_JOB_RUNS),
    };
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.continuationDelivery =
      options.continuationDelivery ?? unavailableContinuationDelivery;
    this.killStragglersAfterGrace = options.killStragglersAfterGrace ?? false;
    this.onMessageRunStart = options.onMessageRunStart;
  }

  getPolicy(): GroupQueuePolicy {
    return { ...this.policy };
  }

  getWorkerInventorySnapshot(): WorkerInventoryQueueSnapshot {
    let pendingConversationKeys = 0;
    for (const state of this.groups.values()) {
      if (state.pendingMessages) pendingConversationKeys++;
    }
    return {
      activeMessageRuns: this.activeMessageCount,
      pendingConversationKeys,
      maxMessageRuns: this.policy.maxMessageRuns,
    };
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskRun: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        runHandle: null,
        groupFolder: null,
        threadId: null,
        requiredContinuationUserId: null,
        pooledWarmWorker: null,
        pooledContinuationActive: false,
        retryCount: 0,
        continuationHandler: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Swap the continuation carrier after construction. The IPC socket server is
   * started after the queue is built, so the push carrier is injected here
   * (symmetric with {@link setProcessMessagesFn}).
   */
  setContinuationDelivery(delivery: ContinuationDelivery): void {
    this.continuationDelivery = delivery;
  }

  private canStartMessageRun(): boolean {
    return this.activeMessageCount < this.policy.maxMessageRuns;
  }

  private canStartTaskRun(): boolean {
    return this.activeTaskCount < this.policy.maxJobRuns;
  }

  private addStopAlias(aliasJid: string, queueJid: string): void {
    if (!aliasJid || aliasJid === queueJid) return;
    const existing = this.stopAliases.get(aliasJid);
    if (existing) {
      existing.add(queueJid);
      return;
    }
    this.stopAliases.set(aliasJid, new Set([queueJid]));
  }

  private removeStopAliasForQueueJid(queueJid: string): void {
    for (const [alias, queueJids] of this.stopAliases.entries()) {
      if (!queueJids.delete(queueJid)) continue;
      if (queueJids.size === 0) this.stopAliases.delete(alias);
    }
  }

  private isEphemeralSchedulerGroup(groupJid: string): boolean {
    return groupJid.startsWith('__scheduler__:');
  }

  private cleanupEphemeralGroupIfIdle(
    groupJid: string,
    state: GroupState,
  ): void {
    if (!this.isEphemeralSchedulerGroup(groupJid)) return;
    if (state.active) return;
    if (state.pendingMessages || state.pendingTasks.length > 0) return;
    if (state.runningTaskId || state.process || state.idleWaiting) return;

    this.groups.delete(groupJid);
    this.removeStopAliasForQueueJid(groupJid);
    this.waitingMessageGroups = this.waitingMessageGroups.filter(
      (jid) => jid !== groupJid,
    );
    this.waitingTaskGroups = this.waitingTaskGroups.filter(
      (jid) => jid !== groupJid,
    );
  }

  private enqueueWaitingGroup(kind: QueueKind, groupJid: string): void {
    const queue =
      kind === 'message' ? this.waitingMessageGroups : this.waitingTaskGroups;
    if (!queue.includes(groupJid)) {
      queue.push(groupJid);
    }
  }

  private dequeueWaitingGroup(kind: QueueKind): string | null {
    const queue =
      kind === 'message' ? this.waitingMessageGroups : this.waitingTaskGroups;
    const originalLength = queue.length;
    for (let i = 0; i < originalLength; i++) {
      const candidate = queue.shift();
      if (!candidate) break;
      const state = this.getGroup(candidate);
      const pending =
        kind === 'message'
          ? state.pendingMessages
          : state.pendingTasks.length > 0;

      if (!pending) {
        continue;
      }

      if (!state.active) {
        return candidate;
      }

      queue.push(candidate);
    }
    return null;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Agent run active, message queued');
      return;
    }

    if (!this.canStartMessageRun()) {
      state.pendingMessages = true;
      this.enqueueWaitingGroup('message', groupJid);
      logger.debug(
        { groupJid, activeMessageCount: this.activeMessageCount },
        'At message concurrency limit, message queued',
      );
      return;
    }

    this.trackRun(
      this.runForGroup(groupJid, 'messages').catch((err) =>
        logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
      ),
    );
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
  ): boolean {
    if (this.shuttingDown) return false;

    const state = this.getGroup(groupJid);

    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return true;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return true;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, kind: 'task', groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Agent run active, task queued');
      return true;
    }

    if (!this.canStartTaskRun()) {
      state.pendingTasks.push({ id: taskId, kind: 'task', groupJid, fn });
      this.enqueueWaitingGroup('task', groupJid);
      logger.debug(
        { groupJid, taskId, activeTaskCount: this.activeTaskCount },
        'At task concurrency limit, task queued',
      );
      return true;
    }

    this.trackRun(
      this.runTask(groupJid, { id: taskId, kind: 'task', groupJid, fn }).catch(
        (err) =>
          logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
      ),
    );
    return true;
  }

  private trackRun(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.activeRuns.delete(tracked);
    });
    this.activeRuns.add(tracked);
    tracked.catch((err) =>
      logger.error({ err }, 'Unhandled error in tracked queue run'),
    );
  }

  private waitForActiveRuns(timeoutMs: number): Promise<void> {
    if (this.activeRuns.size === 0 || timeoutMs <= 0) {
      return Promise.resolve();
    }
    return Promise.race([
      Promise.allSettled([...this.activeRuns]).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private closeActiveMessageRunsForShutdown(): string[] {
    const signaledRuns: string[] = [];
    for (const [groupJid, state] of this.groups) {
      if (!state.active || state.isTaskRun) continue;
      this.closeStdin(groupJid);
      signaledRuns.push(state.runHandle ?? groupJid);
    }
    return signaledRuns;
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    runHandle: string,
    groupFolder?: string,
    stopAliasJids?: string | string[],
    threadId?: string | null,
    options: RegisterProcessOptions = {},
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.runHandle = runHandle;
    if (groupFolder) state.groupFolder = groupFolder;
    state.threadId = normalizeThreadQueueId(threadId) || null;
    state.requiredContinuationUserId =
      options.requiredContinuationUserId?.trim() || null;
    state.pooledWarmWorker = options.pooledWarmWorker ?? null;
    if (typeof proc.once === 'function') {
      proc.once('close', () => {
        void this.releaseRetainedProcessOnClose(groupJid, proc);
      });
    }
    const aliases = Array.isArray(stopAliasJids)
      ? stopAliasJids
      : stopAliasJids
        ? [stopAliasJids]
        : [];
    for (const alias of aliases) this.addStopAlias(alias, groupJid);
  }

  /**
   * Mark the agent run as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle agent run immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (state.pooledContinuationActive) {
      state.pooledContinuationActive = false;
      state.active = false;
      this.activeMessageCount = Math.max(0, this.activeMessageCount - 1);
      state.idleWaiting = true;
      this.drainWaiting();
      return;
    }
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  registerContinuationHandler(
    groupJid: string,
    handler: ContinuationHandler,
  ): () => void {
    const state = this.getGroup(groupJid);
    state.continuationHandler = handler;
    return () => {
      const current = this.groups.get(groupJid);
      if (current?.continuationHandler === handler) {
        current.continuationHandler = null;
      }
    };
  }

  sendMessage(
    groupJid: string,
    text: string,
    options: ContinuationOptions = {},
  ) {
    const state = this.getGroup(groupJid);
    if (
      (!state.active && !state.idleWaiting) ||
      !state.groupFolder ||
      !state.process ||
      state.isTaskRun
    ) {
      return false;
    }
    const incomingThreadId = normalizeThreadQueueId(options.threadId) || null;
    if (state.threadId !== incomingThreadId) {
      return false;
    }
    if (
      state.requiredContinuationUserId &&
      !continuationSenderMatchesRequiredUser(
        options.senderUserIds,
        state.requiredContinuationUserId,
      )
    ) {
      return false;
    }
    const wasRetainedIdle = !state.active && state.idleWaiting;
    if (wasRetainedIdle && !this.canStartMessageRun()) {
      return false;
    }
    const retainedIdleProcess = state.pooledWarmWorker ? state.process : null;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle
    const target: ContinuationTarget = {
      groupFolder: state.groupFolder,
      chatJid: parseThreadQueueKey(groupJid).chatJid,
      // incomingThreadId === state.threadId here (guarded above), so this is
      // byte-identical to the prior `incomingThreadId` write argument.
      threadId: state.threadId ?? null,
      runHandle: state.runHandle ?? null,
    };
    try {
      const delivered = this.continuationDelivery.deliverContinuation(
        target,
        text,
        this.continuationSequence++,
      );
      if (delivered) {
        if (wasRetainedIdle) {
          state.active = true;
          this.activeMessageCount++;
        }
        if (state.pooledWarmWorker) {
          state.pooledContinuationActive = true;
        }
        state.continuationHandler?.();
      }
      if (!delivered && retainedIdleProcess) {
        void this.releaseUndeliverableRetainedProcess(
          groupJid,
          retainedIdleProcess,
        );
      }
      return delivered;
    } catch {
      if (retainedIdleProcess) {
        void this.releaseUndeliverableRetainedProcess(
          groupJid,
          retainedIdleProcess,
        );
      }
      return false;
    }
  }

  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if ((!state.active && !state.idleWaiting) || !state.groupFolder) return;
    const target: ContinuationTarget = {
      groupFolder: state.groupFolder,
      chatJid: parseThreadQueueKey(groupJid).chatJid,
      threadId: state.threadId ?? null,
      runHandle: state.runHandle ?? null,
    };
    try {
      this.continuationDelivery.deliverClose(target);
    } catch {
      // ignore
    }
  }

  stopGroup(groupJid: string): boolean {
    const targetQueueJids = [groupJid];
    const aliased = this.stopAliases.get(groupJid);
    if (aliased) targetQueueJids.push(...aliased);

    for (const targetQueueJid of targetQueueJids) {
      const state = this.groups.get(targetQueueJid);
      const proc = state?.process;
      if (
        !state ||
        (!state.active && !state.idleWaiting) ||
        !proc ||
        proc.killed
      )
        continue;

      const stopped = stopActiveGroupRun({
        groupJid,
        targetQueueJid,
        proc,
        closeStdin: () => this.closeStdin(targetQueueJid),
      });
      if (stopped && !state.active && state.idleWaiting) {
        void this.releaseStoppedIdleRetainedProcess(targetQueueJid, proc);
      }
      return stopped;
    }

    return false;
  }

  isGroupActive(groupJid: string): boolean {
    const targetQueueJids = [groupJid];
    const aliased = this.stopAliases.get(groupJid);
    if (aliased) targetQueueJids.push(...aliased);

    for (const targetQueueJid of targetQueueJids) {
      const state = this.groups.get(targetQueueJid);
      if (!state) continue;
      if ((state.active || state.idleWaiting) && !state.isTaskRun) {
        return true;
      }
    }
    return false;
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskRun = false;
    state.pendingMessages = false;
    this.activeMessageCount++;

    logger.debug(
      {
        groupJid,
        reason,
        activeMessageCount: this.activeMessageCount,
        activeTaskCount: this.activeTaskCount,
      },
      'Starting agent run for group',
    );

    let stopMessageRun: (() => void) | undefined;
    try {
      stopMessageRun = this.onMessageRunStart?.(groupJid) ?? undefined;
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      const pooledWarmWorker = state.pooledWarmWorker;
      const retainIdlePooledWorker =
        state.idleWaiting &&
        pooledWarmWorker !== null &&
        state.process !== null &&
        !state.process.killed &&
        !state.pendingMessages &&
        state.pendingTasks.length === 0;
      const retainPooledContinuation =
        state.pooledContinuationActive &&
        pooledWarmWorker !== null &&
        state.process !== null &&
        !state.process.killed &&
        !state.pendingMessages &&
        state.pendingTasks.length === 0;
      try {
        stopMessageRun?.();
      } catch (err) {
        logger.warn({ groupJid, err }, 'Failed to stop message-run lifecycle');
      }
      if (retainPooledContinuation) {
        this.drainWaiting();
        return;
      }
      if (state.active) {
        state.active = false;
        this.activeMessageCount = Math.max(0, this.activeMessageCount - 1);
      } else {
        state.active = false;
      }
      if (retainIdlePooledWorker) {
        this.drainWaiting();
        return;
      }
      state.process = null;
      state.runHandle = null;
      state.groupFolder = null;
      state.threadId = null;
      state.requiredContinuationUserId = null;
      state.pooledWarmWorker = null;
      state.pooledContinuationActive = false;
      state.idleWaiting = false;
      state.continuationHandler = null;
      if (pooledWarmWorker) {
        await this.releasePooledWarmWorker(groupJid, pooledWarmWorker);
      }
      this.removeStopAliasForQueueJid(groupJid);
      this.drainGroup(groupJid);
    }
  }

  private async releaseRetainedProcessOnClose(
    groupJid: string,
    proc: ChildProcess,
  ): Promise<void> {
    const state = this.groups.get(groupJid);
    if (
      !state ||
      (state.active && !state.pooledContinuationActive) ||
      state.process !== proc
    )
      return;
    const pooledWarmWorker = state.pooledWarmWorker;
    if (state.pooledContinuationActive) {
      this.activeMessageCount = Math.max(0, this.activeMessageCount - 1);
    }
    state.active = false;
    state.process = null;
    state.runHandle = null;
    state.groupFolder = null;
    state.threadId = null;
    state.requiredContinuationUserId = null;
    state.pooledWarmWorker = null;
    state.pooledContinuationActive = false;
    state.idleWaiting = false;
    state.continuationHandler = null;
    if (pooledWarmWorker) {
      await this.releasePooledWarmWorker(groupJid, pooledWarmWorker);
    }
    this.removeStopAliasForQueueJid(groupJid);
    this.drainGroup(groupJid);
  }

  private async releaseStoppedIdleRetainedProcess(
    groupJid: string,
    proc: ChildProcess,
  ): Promise<void> {
    const state = this.groups.get(groupJid);
    if (!state || state.active || !state.idleWaiting || state.process !== proc)
      return;
    const pooledWarmWorker = state.pooledWarmWorker;
    state.process = null;
    state.runHandle = null;
    state.groupFolder = null;
    state.threadId = null;
    state.requiredContinuationUserId = null;
    state.pooledWarmWorker = null;
    state.pooledContinuationActive = false;
    state.idleWaiting = false;
    state.continuationHandler = null;
    if (pooledWarmWorker) {
      await this.releasePooledWarmWorker(groupJid, pooledWarmWorker);
    }
    this.removeStopAliasForQueueJid(groupJid);
    this.drainGroup(groupJid);
  }

  private async releaseUndeliverableRetainedProcess(
    groupJid: string,
    proc: ChildProcess,
  ): Promise<void> {
    const state = this.groups.get(groupJid);
    if (!state || state.process !== proc) return;
    const pooledWarmWorker = state.pooledWarmWorker;
    state.process = null;
    state.runHandle = null;
    state.groupFolder = null;
    state.threadId = null;
    state.requiredContinuationUserId = null;
    state.pooledWarmWorker = null;
    state.pooledContinuationActive = false;
    state.idleWaiting = false;
    state.continuationHandler = null;
    if (pooledWarmWorker) {
      await this.releasePooledWarmWorker(groupJid, pooledWarmWorker);
    }
    this.removeStopAliasForQueueJid(groupJid);
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskRun = true;
    state.runningTaskId = task.id;
    this.activeTaskCount++;

    logger.debug(
      {
        groupJid,
        taskId: task.id,
        taskKind: task.kind,
        activeMessageCount: this.activeMessageCount,
        activeTaskCount: this.activeTaskCount,
      },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      const pooledWarmWorker = state.pooledWarmWorker;
      state.active = false;
      state.isTaskRun = false;
      state.runningTaskId = null;
      state.process = null;
      state.runHandle = null;
      state.groupFolder = null;
      state.threadId = null;
      state.requiredContinuationUserId = null;
      state.pooledWarmWorker = null;
      this.activeTaskCount--;
      if (pooledWarmWorker) {
        await this.releasePooledWarmWorker(groupJid, pooledWarmWorker);
      }
      this.removeStopAliasForQueueJid(groupJid);
      this.drainGroup(groupJid);
    }
  }

  private async releasePooledWarmWorker(
    groupJid: string,
    pooledWarmWorker: PooledWarmWorkerRun,
  ): Promise<void> {
    try {
      await pooledWarmWorker.release();
    } catch (err) {
      logger.warn(
        { groupJid, err, workerId: pooledWarmWorker.handle.id },
        'Failed to release pooled warm worker after run teardown',
      );
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > this.policy.maxRetries) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = this.policy.baseRetryMs * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    this.setTimeoutFn(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.pendingTasks.length > 0) {
      if (!this.canStartTaskRun()) {
        this.enqueueWaitingGroup('task', groupJid);
        this.drainWaiting();
        return;
      }
      const task = state.pendingTasks.shift()!;
      this.trackRun(
        this.runTask(groupJid, task).catch((err) =>
          logger.error(
            { groupJid, taskId: task.id, err },
            'Unhandled error in runTask (drain)',
          ),
        ),
      );
      return;
    }

    if (state.pendingMessages) {
      if (!this.canStartMessageRun()) {
        this.enqueueWaitingGroup('message', groupJid);
        this.drainWaiting();
        return;
      }
      this.trackRun(
        this.runForGroup(groupJid, 'drain').catch((err) =>
          logger.error(
            { groupJid, err },
            'Unhandled error in runForGroup (drain)',
          ),
        ),
      );
      return;
    }

    this.cleanupEphemeralGroupIfIdle(groupJid, state);

    this.drainWaiting();
  }

  private drainWaiting(): void {
    let started = true;
    while (!this.shuttingDown && started) {
      started = false;

      if (this.canStartMessageRun()) {
        const nextMessageJid = this.dequeueWaitingGroup('message');
        if (nextMessageJid) {
          this.trackRun(
            this.runForGroup(nextMessageJid, 'drain').catch((err) =>
              logger.error(
                { groupJid: nextMessageJid, err },
                'Unhandled error in runForGroup (waiting)',
              ),
            ),
          );
          started = true;
          continue;
        }
      }

      if (this.canStartTaskRun()) {
        const nextTaskJid = this.dequeueWaitingGroup('task');
        if (nextTaskJid) {
          const state = this.getGroup(nextTaskJid);
          const task = state.pendingTasks.shift();
          if (task) {
            this.trackRun(
              this.runTask(nextTaskJid, task).catch((err) =>
                logger.error(
                  { groupJid: nextTaskJid, taskId: task.id, err },
                  'Unhandled error in runTask (waiting)',
                ),
              ),
            );
            started = true;
          }
        }
      }
    }
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const detachedRuns: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.runHandle) {
        detachedRuns.push(state.runHandle);
      }
    }
    const signaledRuns = this.closeActiveMessageRunsForShutdown();

    logger.info(
      {
        activeMessageCount: this.activeMessageCount,
        activeTaskCount: this.activeTaskCount,
        detachedRuns,
        signaledRuns,
      },
      'GroupQueue shutting down (active message runs signaled to close)',
    );
    await this.waitForActiveRuns(gracePeriodMs);
    this.killStragglersAfterShutdownGrace();
  }

  /**
   * I-1 (GANTRY_IPC_SHUTDOWN_KILL): after the shutdown grace, any tracked runner
   * process still alive is a straggler. When the flag is OFF (default) we leave
   * it detached — today's exact behavior, recovered on next boot. When ON we
   * SIGKILL it so shutdown is deterministic. Mirrors group-queue-stop's
   * process-group-first, fall-back-to-pid kill, but with SIGKILL (the runner was
   * already SIGTERM-equivalent-signaled via closeStdin; this is the hard escalation).
   */
  private killStragglersAfterShutdownGrace(): void {
    if (!this.killStragglersAfterGrace) return;
    for (const [groupJid, state] of this.groups) {
      const proc = state.process;
      if (!proc || proc.killed) continue;
      const pid = proc.pid;
      try {
        if (typeof pid === 'number' && pid > 0) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            process.kill(pid, 'SIGKILL');
          }
        } else {
          proc.kill('SIGKILL');
        }
        logger.warn(
          { groupJid, pid, runHandle: state.runHandle },
          'SIGKILLed straggler runner after shutdown grace (GANTRY_IPC_SHUTDOWN_KILL)',
        );
      } catch (err) {
        logger.warn(
          { groupJid, pid, runHandle: state.runHandle, err },
          'Failed to SIGKILL straggler runner after shutdown grace',
        );
      }
    }
  }
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

function continuationSenderMatchesRequiredUser(
  senderUserIds: readonly string[] | null | undefined,
  requiredUserId: string,
): boolean {
  const normalizedSenderIds = new Set<string>();
  for (const senderUserId of senderUserIds ?? []) {
    const normalized = senderUserId.trim();
    if (normalized) normalizedSenderIds.add(normalized);
  }
  return (
    normalizedSenderIds.size === 1 && normalizedSenderIds.has(requiredUserId)
  );
}
