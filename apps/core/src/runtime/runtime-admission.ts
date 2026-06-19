import type { QueuedTask, TaskAdmissionClass } from './group-queue-types.js';

export const DEFAULT_TASK_ADMISSION_CLASS: TaskAdmissionClass = 'background';

const TASK_ADMISSION_PRIORITY: Record<TaskAdmissionClass, number> = {
  interactive_child: 0,
  background: 1,
  maintenance: 2,
};

export function enqueueByAdmissionClass<
  T extends { admissionClass: TaskAdmissionClass },
>(pending: T[], task: T): void {
  const taskPriority = TASK_ADMISSION_PRIORITY[task.admissionClass];
  const insertAt = pending.findIndex(
    (queued) => TASK_ADMISSION_PRIORITY[queued.admissionClass] > taskPriority,
  );
  if (insertAt === -1) {
    pending.push(task);
    return;
  }
  pending.splice(insertAt, 0, task);
}

export function createQueuedTask(
  groupJid: string,
  id: string,
  fn: () => Promise<void>,
  admissionClass: TaskAdmissionClass = DEFAULT_TASK_ADMISSION_CLASS,
): QueuedTask {
  return { id, kind: 'task', admissionClass, groupJid, fn };
}

export function dequeueTaskGroupByAdmissionClass(
  waitingTaskGroups: string[],
  groups: ReadonlyMap<
    string,
    { active: boolean; pendingTasks: readonly QueuedTask[] }
  >,
): string | null {
  const originalLength = waitingTaskGroups.length;
  let selectedIndex = -1;
  let selectedGroupJid: string | null = null;
  let selectedPriority = Number.POSITIVE_INFINITY;

  for (let i = 0; i < originalLength; i++) {
    const candidate = waitingTaskGroups[i];
    if (!candidate) continue;
    const state = groups.get(candidate);
    const task = state?.pendingTasks[0];
    if (!task || state.active) continue;

    const priority = TASK_ADMISSION_PRIORITY[task.admissionClass];
    if (priority < selectedPriority) {
      selectedIndex = i;
      selectedPriority = priority;
      selectedGroupJid = candidate;
    }
  }

  if (!selectedGroupJid) return null;
  if (selectedIndex !== -1) waitingTaskGroups.splice(selectedIndex, 1);
  return selectedGroupJid;
}
