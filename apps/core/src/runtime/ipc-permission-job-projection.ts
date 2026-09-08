import { logger } from '../infrastructure/logging/logger.js';
import type { IpcDeps } from './ipc-domain-types.js';
import type { HumanDecisionProjectionInput } from './permission-decision-coordinator.js';

export async function resolveIpcPermissionJobProjection(input: {
  hostJobId?: string;
  deps: Pick<
    IpcDeps,
    'opsRepository' | 'getPermissionDecisionMemoryRepository'
  >;
  guard: HumanDecisionProjectionInput['guard'];
}): Promise<HumanDecisionProjectionInput | undefined> {
  if (!input.hostJobId) return undefined;
  const memory = input.deps.getPermissionDecisionMemoryRepository?.();
  if (!memory) return undefined;
  const warn: HumanDecisionProjectionInput['warn'] = (message, context) =>
    logger.warn({ jobId: input.hostJobId, ...context }, message);
  let ownerPersonId: string | null = null;
  try {
    const job = await input.deps.opsRepository.getJobById(input.hostJobId);
    ownerPersonId = job?.execution_context?.personId?.trim() || null;
    if (!ownerPersonId) {
      warn('Job owner unavailable for human permission decision projection', {
        reason: job ? 'blank_owner' : 'missing_job',
      });
    }
  } catch (error) {
    warn('Job owner lookup failed for human permission decision projection', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  }
  return { ownerPersonId, memory, guard: input.guard, warn };
}
