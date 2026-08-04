export async function hasAsyncTaskRunningCapacity(repository, task, limits) {
    const statuses = ['running'];
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
    return (appActive.length < limits.perApp && agentActive.length < limits.perAgent);
}
