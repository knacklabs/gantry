import type {
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../../domain/ports/async-tasks.js';
import { isAsyncTaskTerminal } from '../../domain/ports/async-tasks.js';
import {
  externalCapabilityCompletionTokenHash,
  externalCapabilityCompletionTokenMatches,
  newExternalCapabilityCompletionToken,
  newExternalCapabilityLeaseToken,
  newExternalCapabilityTaskId,
} from '../../shared/external-capability-task-token.js';
import { nowIso } from '../../shared/time/datetime.js';

const MAX_SUMMARY_CHARS = 1_000;
const MAX_REFERENCE_CHARS = 512;
const MAX_RESULT_BYTES = 256 * 1024;

export interface ExternalCapabilityTaskAcceptance {
  taskId: string;
  completionToken: string;
  status: 'waiting_external' | 'completed';
  created: boolean;
}

export type ExternalCapabilityTaskSettlement =
  | { outcome: 'completed'; task: AsyncTaskRecord }
  | { outcome: 'idempotent'; task: AsyncTaskRecord }
  | { outcome: 'late_ignored'; task: AsyncTaskRecord }
  | { outcome: 'not_found' | 'forbidden' | 'conflict' };

export class ExternalCapabilityTaskService {
  constructor(
    private readonly repository: AsyncTaskRepository,
    private readonly onChanged: () => void = () => undefined,
  ) {}

  async accept(input: {
    appId: string;
    agentId: string;
    conversationId: string;
    threadId?: string | null;
    jobId: string;
    runId: string;
    capabilityId: string;
    operation: string;
    invocationRef: string;
    idempotencyKey: string;
    summary?: string;
  }): Promise<ExternalCapabilityTaskAcceptance> {
    const normalized = validateAcceptance(input);
    const completionToken = newExternalCapabilityCompletionToken();
    const now = nowIso();
    const created = await this.repository.createTaskIdempotently({
      id: newExternalCapabilityTaskId(),
      appId: normalized.appId,
      agentId: normalized.agentId,
      conversationId: normalized.conversationId,
      threadId: normalized.threadId,
      parentRunId: normalized.runId,
      parentJobId: normalized.jobId,
      parentJobRunId: null,
      kind: 'external_capability',
      status: 'waiting_external',
      admissionClass: 'task',
      authoritySnapshotJson: {
        capabilityId: normalized.capabilityId,
        operation: normalized.operation,
      },
      privateCorrelationJson: {
        invocationRef: normalized.invocationRef,
        completionTokenHash: externalCapabilityCompletionTokenHash(completionToken),
        progress: {
          phase: 'waiting_external',
          lastProgress: 'External capability accepted the invocation.',
          lastToolSummary: `${normalized.capabilityId}.${normalized.operation}`,
        },
      },
      idempotencyKey: normalized.idempotencyKey,
      leaseToken: newExternalCapabilityLeaseToken(),
      fencingVersion: 1,
      summary:
        normalized.summary ??
        `${normalized.capabilityId}.${normalized.operation}`,
      now,
    });
    if (!created.created) {
      assertSameAcceptance(created.task, normalized);
      if (
        created.task.status !== 'waiting_external' &&
        created.task.status !== 'completed'
      ) {
        throw new Error(
          `Existing external capability task is ${created.task.status}; retry with a new idempotency key after correcting the submission.`,
        );
      }
      const existingToken =
        created.task.privateCorrelationJson.completionTokenHash;
      if (typeof existingToken !== 'string') {
        throw new Error('Existing external capability task is corrupt.');
      }
      // A replay must not mint a second bearer token. The original submitter
      // retains its token; recovery uses the exceptional reattachment path.
      return {
        taskId: created.task.id,
        completionToken: '',
        status: created.task.status,
        created: false,
      };
    }
    this.onChanged();
    return {
      taskId: created.task.id,
      completionToken,
      status: 'waiting_external',
      created: true,
    };
  }

  async complete(input: {
    appId: string;
    taskId: string;
    completionToken: string;
    completionId: string;
    resultRef: string;
    summary: string;
    result?: Record<string, unknown>;
  }): Promise<ExternalCapabilityTaskSettlement> {
    const task = await this.authorize(input);
    if (!task) return { outcome: 'not_found' };
    if (!externalCapabilityCompletionTokenMatches(
      task.privateCorrelationJson.completionTokenHash,
      input.completionToken,
    )) {
      return { outcome: 'forbidden' };
    }
    const priorCompletionId = task.privateCorrelationJson.completionId;
    if (isAsyncTaskTerminal(task.status)) {
      return priorCompletionId === input.completionId
        ? { outcome: 'idempotent', task }
        : { outcome: 'late_ignored', task };
    }
    if (task.status !== 'waiting_external') return { outcome: 'conflict' };
    const now = nowIso();
    const updated = await this.repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'completed',
      now,
      terminalAt: now,
      outputSummary: bounded(input.summary, 'summary'),
      privateCorrelationJson: {
        ...task.privateCorrelationJson,
        completionId: bounded(input.completionId, 'completionId'),
        resultRef: boundedReference(input.resultRef, 'resultRef'),
        result: boundedResult(input.result ?? {}),
        progress: {
          phase: 'completed',
          lastProgress: bounded(input.summary, 'summary'),
          lastToolSummary: task.summary ?? task.id,
        },
      },
      receiptJson: {
        completed: bounded(input.summary, 'summary'),
        used: String(task.authoritySnapshotJson.capabilityId ?? 'capability'),
        changed: 'external capability result committed',
        delegated: 'no',
        needsAttention: 'none',
      },
    });
    if (!updated) {
      const winner = await this.repository.getTask(task.id);
      if (!winner) return { outcome: 'not_found' };
      return winner.privateCorrelationJson.completionId === input.completionId
        ? { outcome: 'idempotent', task: winner }
        : { outcome: 'late_ignored', task: winner };
    }
    this.onChanged();
    return { outcome: 'completed', task: updated };
  }

  async cancel(input: {
    appId: string;
    taskId: string;
    completionToken: string;
    cancellationId: string;
    reason: string;
  }): Promise<ExternalCapabilityTaskSettlement> {
    const task = await this.authorize(input);
    if (!task) return { outcome: 'not_found' };
    if (!externalCapabilityCompletionTokenMatches(
      task.privateCorrelationJson.completionTokenHash,
      input.completionToken,
    )) {
      return { outcome: 'forbidden' };
    }
    if (isAsyncTaskTerminal(task.status)) {
      return task.privateCorrelationJson.cancellationId === input.cancellationId
        ? { outcome: 'idempotent', task }
        : { outcome: 'late_ignored', task };
    }
    if (task.status !== 'waiting_external') return { outcome: 'conflict' };
    const now = nowIso();
    const reason = bounded(input.reason, 'reason');
    const updated = await this.repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'cancelled',
      now,
      terminalAt: now,
      errorSummary: reason,
      privateCorrelationJson: {
        ...task.privateCorrelationJson,
        cancellationId: bounded(input.cancellationId, 'cancellationId'),
        progress: {
          phase: 'cancelled',
          lastProgress: reason,
          lastToolSummary: task.summary ?? task.id,
        },
      },
      receiptJson: {
        completed: 'cancelled',
        used: String(task.authoritySnapshotJson.capabilityId ?? 'capability'),
        changed: 'none',
        delegated: 'no',
        needsAttention: reason,
      },
    });
    if (!updated) {
      const winner = await this.repository.getTask(task.id);
      if (!winner) return { outcome: 'not_found' };
      return winner.privateCorrelationJson.cancellationId === input.cancellationId
        ? { outcome: 'idempotent', task: winner }
        : { outcome: 'late_ignored', task: winner };
    }
    this.onChanged();
    return { outcome: 'completed', task: updated };
  }

  async recover(input: {
    appId: string;
    idempotencyKey: string;
    capabilityId: string;
    operation: string;
  }): Promise<ExternalCapabilityTaskAcceptance | null> {
    const task = await this.repository.getTaskByIdempotencyKey({
      appId: input.appId,
      kind: 'external_capability',
      idempotencyKey: boundedReference(input.idempotencyKey, 'idempotencyKey'),
    });
    if (
      !task ||
      task.status !== 'waiting_external' ||
      task.authoritySnapshotJson.capabilityId !== input.capabilityId ||
      task.authoritySnapshotJson.operation !== input.operation
    ) {
      return null;
    }
    const completionToken = newExternalCapabilityCompletionToken();
    const rotated = await this.repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'waiting_external',
      now: nowIso(),
      privateCorrelationJson: {
        ...task.privateCorrelationJson,
        completionTokenHash: externalCapabilityCompletionTokenHash(completionToken),
      },
      expectedUpdatedAt: task.updatedAt,
      expectedPrivateCorrelationJson: task.privateCorrelationJson,
    });
    if (!rotated) return null;
    return {
      taskId: rotated.id,
      completionToken,
      status: 'waiting_external',
      created: false,
    };
  }

  private async authorize(input: { appId: string; taskId: string }) {
    const task = await this.repository.getTask(input.taskId);
    return task?.kind === 'external_capability' && task.appId === input.appId
      ? task
      : null;
  }
}

function boundedResult(value: Record<string, unknown>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('result must be an object.');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('result is too large.');
  }
  return value;
}

function validateAcceptance<
  T extends {
    appId: string;
    agentId: string;
    conversationId: string;
    threadId?: string | null;
    jobId: string;
    runId: string;
    capabilityId: string;
    operation: string;
    invocationRef: string;
    idempotencyKey: string;
    summary?: string;
  },
>(input: T) {
  return {
    appId: boundedReference(input.appId, 'appId'),
    agentId: boundedReference(input.agentId, 'agentId'),
    conversationId: boundedReference(input.conversationId, 'conversationId'),
    threadId: input.threadId
      ? boundedReference(input.threadId, 'threadId')
      : null,
    jobId: boundedReference(input.jobId, 'jobId'),
    runId: boundedReference(input.runId, 'runId'),
    capabilityId: boundedReference(input.capabilityId, 'capabilityId'),
    operation: boundedReference(input.operation, 'operation'),
    invocationRef: boundedReference(input.invocationRef, 'invocationRef'),
    idempotencyKey: boundedReference(input.idempotencyKey, 'idempotencyKey'),
    summary: input.summary ? bounded(input.summary, 'summary') : undefined,
  };
}

function assertSameAcceptance(
  task: AsyncTaskRecord,
  input: ReturnType<typeof validateAcceptance>,
) {
  if (
    task.agentId !== input.agentId ||
    task.conversationId !== input.conversationId ||
    (task.threadId ?? null) !== input.threadId ||
    task.parentJobId !== input.jobId ||
    task.parentRunId !== input.runId ||
    task.authoritySnapshotJson.capabilityId !== input.capabilityId ||
    task.authoritySnapshotJson.operation !== input.operation ||
    task.privateCorrelationJson.invocationRef !== input.invocationRef
  ) {
    throw new Error(
      'External capability idempotency key was reused for different work.',
    );
  }
}

function bounded(value: string, name: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim().slice(0, MAX_SUMMARY_CHARS);
}

function boundedReference(value: string, name: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_REFERENCE_CHARS) {
    throw new Error(`${name} is too long.`);
  }
  return normalized;
}
