import type { GroupProcessingDeps } from './group-processing-types.js';

export function hasAsyncTaskRepository(deps: GroupProcessingDeps): boolean {
  try {
    return Boolean(deps.getAsyncTaskRepository?.());
  } catch {
    return false;
  }
}
