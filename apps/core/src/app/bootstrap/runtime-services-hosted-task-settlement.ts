import type {
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../../domain/ports/async-tasks.js';
import { stableSha256Json } from '../../shared/stable-hash.js';

export async function settleAcknowledgedHostedTask(
  repository: AsyncTaskRepository,
  task: AsyncTaskRecord,
): Promise<boolean> {
  if (task.status !== 'waiting_external') return task.status === 'completed';
  const state = task.privateCorrelationJson.hostedCommit as Record<
    string,
    unknown
  >;
  const result = state.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Hosted commit acknowledgement result is invalid.');
  }
  if (
    Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024 ||
    state.resultSha256 !== stableSha256Json(result)
  ) {
    throw new Error('Hosted commit acknowledgement integrity failed.');
  }
  const completionId = `hosted:${stableSha256Json(result)}`;
  const now = new Date().toISOString();
  const updated = await repository.transitionTask({
    taskId: task.id,
    leaseToken: task.leaseToken,
    fencingVersion: task.fencingVersion,
    status: 'completed',
    now,
    terminalAt: now,
    outputSummary: 'Gantry-hosted capability completed.',
    expectedUpdatedAt: task.updatedAt,
    expectedPrivateCorrelationJson: task.privateCorrelationJson,
    privateCorrelationJson: {
      ...task.privateCorrelationJson,
      completionId,
      resultRef:
        typeof task.privateCorrelationJson.invocationRef === 'string'
          ? task.privateCorrelationJson.invocationRef
          : `task:${task.id}`,
      result,
      progress: {
        phase: 'completed',
        lastProgress: 'Gantry-hosted capability completed.',
        lastToolSummary: task.summary ?? task.id,
      },
    },
    receiptJson: {
      completed: 'Gantry-hosted capability completed.',
      used: String(task.authoritySnapshotJson.capabilityId ?? 'capability'),
      changed: 'external capability result committed',
      delegated: 'no',
      needsAttention: 'none',
    },
  });
  if (updated) return true;
  const winner = await repository.getTask(task.id);
  return Boolean(
    winner?.status === 'completed' &&
    winner.privateCorrelationJson.completionId === completionId,
  );
}
