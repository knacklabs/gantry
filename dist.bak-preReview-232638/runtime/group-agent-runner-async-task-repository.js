export function hasAsyncTaskRepository(deps) {
    try {
        return Boolean(deps.getAsyncTaskRepository?.());
    }
    catch {
        return false;
    }
}
