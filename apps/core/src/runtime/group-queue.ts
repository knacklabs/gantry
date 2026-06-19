import type { ChildProcess } from 'child_process';

import { logger } from '../infrastructure/logging/logger.js';
import { stopActiveGroupRun } from './group-queue-stop.js';
import { normalizeThreadQueueId } from '../shared/thread-queue-key.js';
import {
  continuationSenderMatchesRequiredUser,
  createGroupQueuePolicy,
  UNLIMITED_QUEUE_BACKLOG,
  type GroupQueuePolicy,
} from './group-queue-policy.js';
import { createLiveTurnLocalRunnerHooks } from './group-queue-live-turn-hooks.js';
import {
  localContinuationRunnerControlPort,
  type ContinuationHandler,
  type ContinuationOptions,
  type ContinuationRunnerControlPort,
  type GroupQueueOptions,
  type QueueKind,
  type QueuedTask,
} from './group-queue-types.js';
import type { LiveTurnLocalRunnerHooks } from './live-turn-authority.js';
import * as admission from './runtime-admission.js';

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskRun: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  runHandle: string | null;
  workspaceFolder: string | null;
  threadId: string | null;
  requiredContinuationUserId: string | null;
  retryCount: number;
  continuationHandler: ContinuationHandler | null;
}

export class GroupQueue {
  private readonly policy: GroupQueuePolicy;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly runnerControlPort: ContinuationRunnerControlPort;
  private groups = new Map<string, GroupState>();
  private stopAliases = new Map<string, Set<string>>();
  private activeMessageCount = 0;
  private activeTaskCount = 0;
  private waitingMessageGroups: string[] = [];
  private waitingTaskGroups: string[] = [];
  private continuationSequence = 0;
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private liveTurnRunnerRegistrar:
    | ((
        queueJid: string,
        hooks: LiveTurnLocalRunnerHooks,
        routing: {
          stopAliasJids?: string[];
          requiredContinuationUserId?: string | null;
        },
      ) => Promise<void> | void)
    | null = null;
  private shuttingDown = false;
  private activeRuns = new Set<Promise<void>>();

  constructor(options: GroupQueueOptions = {}) {
    this.policy = createGroupQueuePolicy(options);
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.runnerControlPort =
      options.runnerControlPort ?? localContinuationRunnerControlPort;
  }

  getPolicy(): GroupQueuePolicy {
    return { ...this.policy };
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
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
        workspaceFolder: null,
        threadId: null,
        requiredContinuationUserId: null,
        retryCount: 0,
        continuationHandler: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private deleteGroupIfIdle(groupJid: string, state: GroupState): boolean {
    if (state.active || state.pendingMessages || state.pendingTasks.length > 0)
      return false;
    if (state.runningTaskId || state.process || state.idleWaiting) return false;
    return this.groups.delete(groupJid);
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  setLiveTurnRunnerRegistrar(
    registrar:
      | ((
          queueJid: string,
          hooks: LiveTurnLocalRunnerHooks,
          routing: {
            stopAliasJids?: string[];
            requiredContinuationUserId?: string | null;
          },
        ) => Promise<void> | void)
      | null,
  ): void {
    this.liveTurnRunnerRegistrar = registrar;
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

  private cleanupEphemeralGroupIfIdle(
    groupJid: string,
    state: GroupState,
  ): void {
    if (!groupJid.startsWith('__scheduler__:')) return;
    if (!this.deleteGroupIfIdle(groupJid, state)) return;
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
    if (!queue.includes(groupJid)) queue.push(groupJid);
  }

  private canAcceptWaitingMessageGroup(groupJid: string): boolean {
    if (this.policy.maxMessageBacklog === UNLIMITED_QUEUE_BACKLOG) return true;
    if (this.waitingMessageGroups.includes(groupJid)) return true;
    return this.waitingMessageGroups.length < this.policy.maxMessageBacklog;
  }

  private refillWaitingMessageBacklog(): void {
    if (this.policy.maxMessageBacklog === UNLIMITED_QUEUE_BACKLOG) return;
    for (const [groupJid, state] of this.groups.entries()) {
      if (!state.pendingMessages || state.active) continue;
      if (this.waitingMessageGroups.includes(groupJid)) continue;
      if (!this.canAcceptWaitingMessageGroup(groupJid)) return;
      this.enqueueWaitingGroup('message', groupJid);
    }
  }

  private pendingTaskCount(): number {
    let count = 0;
    for (const state of this.groups.values())
      count += state.pendingTasks.length;
    return count;
  }

  private canAcceptPendingTask(): boolean {
    return (
      this.policy.maxTaskBacklog === UNLIMITED_QUEUE_BACKLOG ||
      this.pendingTaskCount() < this.policy.maxTaskBacklog
    );
  }

  private rejectTaskBacklog(
    groupJid: string,
    taskId: string,
    state: GroupState,
  ): false {
    logger.warn(
      {
        groupJid,
        taskId,
        maxTaskBacklog: this.policy.maxTaskBacklog,
        pendingTaskCount: this.pendingTaskCount(),
      },
      'Task queue backlog cap reached, rejecting task',
    );
    this.deleteGroupIfIdle(groupJid, state);
    return false;
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

      if (!pending) continue;
      if (!state.active) return candidate;

      queue.push(candidate);
    }
    return null;
  }

  enqueueMessageCheck(groupJid: string): boolean {
    if (this.shuttingDown) return false;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Agent run active, message queued');
      return true;
    }

    if (this.activeMessageCount >= this.policy.maxMessageRuns) {
      if (!this.canAcceptWaitingMessageGroup(groupJid)) {
        logger.warn(
          {
            groupJid,
            maxMessageBacklog: this.policy.maxMessageBacklog,
            waitingMessageGroups: this.waitingMessageGroups.length,
          },
          'Message queue backlog cap reached, deferring enqueue signal',
        );
        state.pendingMessages = true;
        return false;
      }
      state.pendingMessages = true;
      this.enqueueWaitingGroup('message', groupJid);
      logger.debug(
        { groupJid, activeMessageCount: this.activeMessageCount },
        'At message concurrency limit, message queued',
      );
      return true;
    }

    this.trackRun(
      this.runForGroup(groupJid, 'messages').catch((err) =>
        logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
      ),
    );
    return true;
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
    options: { admissionClass?: QueuedTask['admissionClass'] } = {},
  ): boolean {
    if (this.shuttingDown) return false;

    const state = this.getGroup(groupJid);
    const task = admission.createQueuedTask(
      groupJid,
      taskId,
      fn,
      options.admissionClass,
    );

    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return true;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return true;
    }

    if (state.active) {
      if (!this.canAcceptPendingTask()) {
        return this.rejectTaskBacklog(groupJid, taskId, state);
      }
      admission.enqueueByAdmissionClass(state.pendingTasks, task);
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Agent run active, task queued');
      return true;
    }

    if (state.pendingMessages && task.admissionClass !== 'interactive_child') {
      if (!this.canAcceptPendingTask()) {
        return this.rejectTaskBacklog(groupJid, taskId, state);
      }
      admission.enqueueByAdmissionClass(state.pendingTasks, task);
      return true;
    }
    if (this.activeTaskCount >= this.policy.maxJobRuns) {
      if (!this.canAcceptPendingTask()) {
        return this.rejectTaskBacklog(groupJid, taskId, state);
      }
      admission.enqueueByAdmissionClass(state.pendingTasks, task);
      this.enqueueWaitingGroup('task', groupJid);
      logger.debug(
        { groupJid, taskId, activeTaskCount: this.activeTaskCount },
        'At task concurrency limit, task queued',
      );
      return true;
    }

    this.trackRun(
      this.runTask(groupJid, task).catch((err) =>
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
    if (this.activeRuns.size === 0 || timeoutMs <= 0) return Promise.resolve();
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
    workspaceFolder?: string,
    stopAliasJids?: string | string[],
    threadId?: string | null,
    options: { requiredContinuationUserId?: string | null } = {},
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.runHandle = runHandle;
    if (workspaceFolder) state.workspaceFolder = workspaceFolder;
    state.threadId = normalizeThreadQueueId(threadId) || null;
    state.requiredContinuationUserId =
      options.requiredContinuationUserId?.trim() || null;
    const aliases = Array.isArray(stopAliasJids)
      ? stopAliasJids
      : stopAliasJids
        ? [stopAliasJids]
        : [];
    for (const alias of aliases) this.addStopAlias(alias, groupJid);
    if (!state.isTaskRun) {
      const hooks = createLiveTurnLocalRunnerHooks({
        groupJid,
        state,
        runnerControlPort: this.runnerControlPort,
        closeStdin: () => this.closeStdin(groupJid),
        stopGroup: () => this.stopGroup(groupJid),
      });
      void Promise.resolve(
        this.liveTurnRunnerRegistrar?.(groupJid, hooks, {
          stopAliasJids: aliases,
          requiredContinuationUserId: state.requiredContinuationUserId,
        }),
      ).catch((err) =>
        logger.warn(
          { groupJid, err },
          'Failed to register live-turn local runner hooks',
        ),
      );
    }
  }

  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
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
    if (!state.active || !state.workspaceFolder || state.isTaskRun)
      return false;
    const incomingThreadId = normalizeThreadQueueId(options.threadId) || null;
    if (state.threadId !== incomingThreadId) return false;
    if (
      state.requiredContinuationUserId &&
      !continuationSenderMatchesRequiredUser(
        options.senderUserIds,
        state.requiredContinuationUserId,
      )
    ) {
      return false;
    }
    state.idleWaiting = false; // Agent is about to receive work, no longer idle
    try {
      this.runnerControlPort.writeContinuationInput({
        workspaceFolder: state.workspaceFolder,
        text,
        sequence: this.continuationSequence++,
        threadId: incomingThreadId,
      });
      state.continuationHandler?.();
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.workspaceFolder) return;
    try {
      this.runnerControlPort.writeCloseSignal({
        workspaceFolder: state.workspaceFolder,
        threadId: state.threadId,
      });
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
      if (state.active && !state.isTaskRun) {
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
      state.runHandle = null;
      state.workspaceFolder = null;
      state.threadId = null;
      state.requiredContinuationUserId = null;
      state.continuationHandler = null;
      this.activeMessageCount--;
      this.removeStopAliasForQueueJid(groupJid);
      this.drainGroup(groupJid);
    }
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
      state.active = false;
      state.isTaskRun = false;
      state.runningTaskId = null;
      state.process = null;
      state.runHandle = null;
      state.workspaceFolder = null;
      state.threadId = null;
      state.requiredContinuationUserId = null;
      this.activeTaskCount--;
      this.removeStopAliasForQueueJid(groupJid);
      this.drainGroup(groupJid);
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

    if (
      state.pendingMessages &&
      state.pendingTasks[0]?.admissionClass !== 'interactive_child'
    ) {
      if (this.activeMessageCount >= this.policy.maxMessageRuns) {
        if (!this.canAcceptWaitingMessageGroup(groupJid)) {
          logger.warn(
            {
              groupJid,
              maxMessageBacklog: this.policy.maxMessageBacklog,
              waitingMessageGroups: this.waitingMessageGroups.length,
            },
            'Message queue backlog cap reached, deferring enqueue signal',
          );
          this.drainWaiting();
          return;
        }
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

    if (state.pendingTasks.length > 0) {
      if (this.activeTaskCount >= this.policy.maxJobRuns) {
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

    this.cleanupEphemeralGroupIfIdle(groupJid, state);

    this.drainWaiting();
  }

  private drainWaiting(): void {
    let started = true;
    while (!this.shuttingDown && started) {
      this.refillWaitingMessageBacklog();
      started = false;

      if (this.activeMessageCount < this.policy.maxMessageRuns) {
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

      if (this.activeTaskCount < this.policy.maxJobRuns) {
        const nextTaskJid = admission.dequeueTaskGroupByAdmissionClass(
          this.waitingTaskGroups,
          this.groups,
        );
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
  }
}
