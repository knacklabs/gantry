import type {
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';

export async function hasAsyncTaskRunningCapacity(
  repository: AsyncTaskRepository,
  task: AsyncTaskRecord,
  limits: { perApp: number; perAgent: number },
): Promise<boolean> {
  const statuses: AsyncTaskRecord['status'][] = ['running'];
  const [appActive, agentActive] = await Promise.all([
    repository.listTasks({
      appId: task.appId,
      kind: task.kind,
      statuses,
      limit: limits.perApp,
    }),
    repository.listTasks({
      appId: task.appId,
      agentId: task.agentId,
      kind: task.kind,
      statuses,
      limit: limits.perAgent,
    }),
  ]);
  return (
    appActive.length < limits.perApp && agentActive.length < limits.perAgent
  );
}
