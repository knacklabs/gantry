import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../core/config.js';
import { logger } from '../core/logger.js';

type QueueKind = 'message' | 'task';

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
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private stopAliases = new Map<string, Set<string>>();
  private activeMessageCount = 0;
  private activeTaskCount = 0;
  private waitingMessageGroups: string[] = [];
  private waitingTaskGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

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
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
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

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
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

    // Run immediately
    this.runTask(groupJid, { id: taskId, kind: 'task', groupJid, fn }).catch(
      (err) =>
        logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    stopAliasJids?: string | string[],
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
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

  /**
   * Send a follow-up message to the active agent run via IPC file.
   * Returns true if the message was written, false if no active agent run.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (
      !state.active ||
      !state.groupFolder ||
      state.isTaskContainer ||
      state.idleWaiting
    )
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active agent run to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Stop the currently active run for a group using SIGTERM only.
   * Returns true when a live process was signaled, false otherwise.
   */
  stopGroup(groupJid: string): boolean {
    const targetQueueJids = [groupJid];
    const aliased = this.stopAliases.get(groupJid);
    if (aliased) targetQueueJids.push(...aliased);

    for (const targetQueueJid of targetQueueJids) {
      const state = this.groups.get(targetQueueJid);
      const proc = state?.process;
      if (!state || !state.active || !proc || proc.killed) continue;

      // Ask the runner to close cleanly as well.
      this.closeStdin(targetQueueJid);

      const pid = proc.pid;
      if (typeof pid !== 'number' || pid <= 0) {
        try {
          proc.kill('SIGTERM');
          logger.warn(
            { groupJid, targetQueueJid },
            'Stop requested for active run (SIGTERM)',
          );
          return true;
        } catch (err) {
          logger.warn(
            { groupJid, targetQueueJid, err },
            'Failed to stop active run (missing pid)',
          );
          return false;
        }
      }

      try {
        process.kill(-pid, 'SIGTERM');
        logger.warn(
          { groupJid, targetQueueJid, pid },
          'Stop requested for active run (SIGTERM process group)',
        );
        return true;
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
          logger.warn(
            { groupJid, targetQueueJid, pid },
            'Stop requested for active run (SIGTERM process)',
          );
          return true;
        } catch (err) {
          logger.warn(
            { groupJid, targetQueueJid, pid, err },
            'Failed to stop active run (SIGTERM)',
          );
          return false;
        }
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

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      if (!this.canStartTaskRun()) {
        this.enqueueWaitingGroup('task', groupJid);
        this.drainWaiting();
        return;
      }
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      if (!this.canStartMessageRun()) {
        this.enqueueWaitingGroup('message', groupJid);
        this.drainWaiting();
        return;
      }
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    this.cleanupEphemeralGroupIfIdle(groupJid, state);

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    let started = true;
    while (!this.shuttingDown && started) {
      started = false;

      if (this.canStartMessageRun()) {
        const nextMessageJid = this.dequeueWaitingGroup('message');
        if (nextMessageJid) {
          this.runForGroup(nextMessageJid, 'drain').catch((err) =>
            logger.error(
              { groupJid: nextMessageJid, err },
              'Unhandled error in runForGroup (waiting)',
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
            this.runTask(nextTaskJid, task).catch((err) =>
              logger.error(
                { groupJid: nextTaskJid, taskId: task.id, err },
                'Unhandled error in runTask (waiting)',
              ),
            );
            started = true;
          }
        }
      }
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active agent runs but don't kill them — they'll finish on their own
    // via idle timeout or agent timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
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
  }
}
