import { ChildProcess } from 'child_process';

import { logger } from '../infrastructure/logging/logger.js';
import {
  writeCloseSignal,
  writeContinuationInput,
} from './continuation-input.js';
import { stopActiveGroupRun } from './group-queue-stop.js';
import { normalizeThreadQueueId } from './thread-queue-key.js';

type QueueKind = 'message' | 'task';
type ContinuationOptions = { threadId?: string | null };

interface QueuedTask {
  id: string;
  kind: QueueKind;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const MAX_MESSAGE_CONTAINERS = 3;
const MAX_JOB_CONTAINERS = 4;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  threadId: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private stopAliases = new Map<string, Set<string>>();
  private activeMessageCount = 0;
  private activeTaskCount = 0;
  private waitingMessageGroups: string[] = [];
  private waitingTaskGroups: string[] = [];
  private continuationSequence = 0;
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private activeRuns = new Set<Promise<void>>();

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        threadId: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  private canStartMessageRun(): boolean {
    return this.activeMessageCount < MAX_MESSAGE_CONTAINERS;
  }

  private canStartTaskRun(): boolean {
    return this.activeTaskCount < MAX_JOB_CONTAINERS;
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

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, kind: 'task', groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Agent run active, task queued');
      return;
    }

    if (!this.canStartTaskRun()) {
      state.pendingTasks.push({ id: taskId, kind: 'task', groupJid, fn });
      this.enqueueWaitingGroup('task', groupJid);
      logger.debug(
        { groupJid, taskId, activeTaskCount: this.activeTaskCount },
        'At task concurrency limit, task queued',
      );
      return;
    }

    this.trackRun(
      this.runTask(groupJid, { id: taskId, kind: 'task', groupJid, fn }).catch(
        (err) =>
          logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
      ),
    );
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

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    stopAliasJids?: string | string[],
    threadId?: string | null,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    state.threadId = normalizeThreadQueueId(threadId) || null;
    const aliases = Array.isArray(stopAliasJids)
      ? stopAliasJids
      : stopAliasJids
        ? [stopAliasJids]
        : [];
    for (const alias of aliases) this.addStopAlias(alias, groupJid);
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle agent run immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  sendMessage(
    groupJid: string,
    text: string,
    options: ContinuationOptions = {},
  ) {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    const incomingThreadId = normalizeThreadQueueId(options.threadId) || null;
    if (state.threadId !== incomingThreadId) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle
    try {
      writeContinuationInput(
        state.groupFolder,
        text,
        this.continuationSequence++,
        incomingThreadId,
      );
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;
    try {
      writeCloseSignal(state.groupFolder, state.threadId);
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
      if (!state || !state.active || !proc || proc.killed) continue;

      return stopActiveGroupRun({
        groupJid,
        targetQueueJid,
        proc,
        closeStdin: () => this.closeStdin(targetQueueJid),
      });
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
      if (state.active && !state.isTaskContainer) {
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
    state.isTaskContainer = false;
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

    try {
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
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.threadId = null;
      this.activeMessageCount--;
      this.removeStopAliasForQueueJid(groupJid);
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
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
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.threadId = null;
      this.activeTaskCount--;
      this.removeStopAliasForQueueJid(groupJid);
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
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

    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      {
        activeMessageCount: this.activeMessageCount,
        activeTaskCount: this.activeTaskCount,
        detachedContainers: activeContainers,
      },
      'GroupQueue shutting down (agent runs detached, not killed)',
    );
    await this.waitForActiveRuns(gracePeriodMs);
  }
}
