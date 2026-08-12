import { and, desc, eq, gt, inArray } from 'drizzle-orm';

import type {
  AppendJobSemanticCheckpointResult,
  JobSemanticCheckpoint,
  JobSemanticCheckpointMilestone,
  JobSemanticCheckpointPayload,
  JobSemanticCheckpointRepository,
} from '../../../../domain/ports/job-semantic-checkpoints.js';
import { JOB_SEMANTIC_CHECKPOINT_MILESTONES } from '../../../../domain/ports/job-semantic-checkpoints.js';
import { jobArtifactScope } from '../../../../domain/ports/job-semantic-checkpoints.js';
import { stableSha256Json } from '../../../../shared/stable-hash.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

type CheckpointRow =
  typeof pgSchema.jobSemanticCheckpointsPostgres.$inferSelect;

const MILESTONES = new Set<string>(JOB_SEMANTIC_CHECKPOINT_MILESTONES);
const MAX_ARTIFACT_REFS = 64;
const MAX_SAFE_PHASE_CHARS = 120;
const MAX_NEXT_ACTION_CHARS = 2_000;

export class InvalidJobSemanticCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobSemanticCheckpointError';
  }
}

export class CorruptJobSemanticCheckpointError extends Error {
  constructor(checkpointId: string) {
    super(`Job semantic checkpoint ${checkpointId} failed hash verification.`);
    this.name = 'CorruptJobSemanticCheckpointError';
  }
}

export class PostgresJobSemanticCheckpointRepository implements JobSemanticCheckpointRepository {
  constructor(private readonly db: CanonicalDb) {}

  async appendCheckpoint(input: {
    id: string;
    appId: string;
    agentId: string;
    jobId: string;
    runId: string;
    leaseToken: string;
    expectedPreviousSequence: number;
    milestone: JobSemanticCheckpointMilestone;
    payload: JobSemanticCheckpointPayload;
    now?: string;
  }): Promise<AppendJobSemanticCheckpointResult> {
    if (!MILESTONES.has(input.milestone)) {
      throw new InvalidJobSemanticCheckpointError(
        `Unsupported semantic checkpoint milestone: ${input.milestone}`,
      );
    }
    const payload = normalizePayload(input.payload);
    const createdAt = input.now ?? nowIso();

    return this.db.transaction(async (tx) => {
      const leases = await tx
        .select()
        .from(pgSchema.runLeasesPostgres)
        .where(
          and(
            eq(pgSchema.runLeasesPostgres.runId, input.runId),
            eq(pgSchema.runLeasesPostgres.leaseToken, input.leaseToken),
            eq(pgSchema.runLeasesPostgres.jobId, input.jobId),
            eq(pgSchema.runLeasesPostgres.status, 'active'),
            gt(pgSchema.runLeasesPostgres.expiresAt, createdAt),
          ),
        )
        .limit(1)
        .for('update');
      const lease = leases[0];
      if (!lease) {
        return { outcome: 'fenced' };
      }

      const ownedJobs = await tx
        .select({ id: pgSchema.canonicalJobsPostgres.id })
        .from(pgSchema.canonicalJobsPostgres)
        .innerJoin(
          pgSchema.agentsPostgres,
          and(
            eq(
              pgSchema.canonicalJobsPostgres.agentId,
              pgSchema.agentsPostgres.id,
            ),
            eq(pgSchema.agentsPostgres.appId, input.appId),
          ),
        )
        .where(
          and(
            eq(pgSchema.canonicalJobsPostgres.id, input.jobId),
            eq(pgSchema.agentsPostgres.id, input.agentId),
          ),
        )
        .limit(1);
      if (!ownedJobs[0]) {
        throw new InvalidJobSemanticCheckpointError(
          'The checkpoint job is not owned by the supplied app and agent.',
        );
      }

      const existingById = await tx
        .select()
        .from(pgSchema.jobSemanticCheckpointsPostgres)
        .where(eq(pgSchema.jobSemanticCheckpointsPostgres.id, input.id))
        .limit(1);
      if (existingById[0]) {
        const checkpoint = toCheckpoint(existingById[0]);
        if (
          checkpoint.appId === input.appId &&
          checkpoint.agentId === input.agentId &&
          checkpoint.jobId === input.jobId &&
          checkpoint.milestone === input.milestone &&
          stableSha256Json(checkpoint.payload) === stableSha256Json(payload)
        ) {
          return { outcome: 'replayed', checkpoint };
        }
        return {
          outcome: 'sequence_conflict',
          latestSequence: checkpoint.sequence,
        };
      }

      const latestRows = await tx
        .select()
        .from(pgSchema.jobSemanticCheckpointsPostgres)
        .where(
          and(
            eq(pgSchema.jobSemanticCheckpointsPostgres.appId, input.appId),
            eq(pgSchema.jobSemanticCheckpointsPostgres.agentId, input.agentId),
            eq(pgSchema.jobSemanticCheckpointsPostgres.jobId, input.jobId),
          ),
        )
        .orderBy(desc(pgSchema.jobSemanticCheckpointsPostgres.sequence))
        .limit(1);
      const latestSequence = latestRows[0]?.sequence ?? 0;
      if (latestSequence !== input.expectedPreviousSequence) {
        return { outcome: 'sequence_conflict', latestSequence };
      }

      await assertArtifactScope(tx, {
        appId: input.appId,
        agentId: input.agentId,
        jobId: input.jobId,
        payload,
      });

      const sequence = latestSequence + 1;
      const payloadHash = checkpointHash({
        id: input.id,
        appId: input.appId,
        agentId: input.agentId,
        jobId: input.jobId,
        runId: input.runId,
        sequence,
        workerInstanceId: lease.workerInstanceId,
        fencingVersion: lease.fencingVersion,
        milestone: input.milestone,
        payload,
      });
      const inserted = await tx
        .insert(pgSchema.jobSemanticCheckpointsPostgres)
        .values({
          id: input.id,
          appId: input.appId,
          agentId: input.agentId,
          jobId: input.jobId,
          runId: input.runId,
          sequence,
          workerInstanceId: lease.workerInstanceId,
          fencingVersion: lease.fencingVersion,
          milestone: input.milestone,
          payloadJson: payload,
          payloadHash,
          createdAt,
        })
        .returning();
      return { outcome: 'persisted', checkpoint: toCheckpoint(inserted[0]!) };
    });
  }

  async getLatestCheckpoint(input: {
    appId: string;
    agentId: string;
    jobId: string;
  }): Promise<JobSemanticCheckpoint | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.jobSemanticCheckpointsPostgres)
      .where(jobScopeClause(input))
      .orderBy(desc(pgSchema.jobSemanticCheckpointsPostgres.sequence))
      .limit(1);
    return rows[0] ? toCheckpoint(rows[0]) : null;
  }

  async getCheckpoint(input: {
    appId: string;
    agentId: string;
    jobId: string;
    sequence: number;
  }): Promise<JobSemanticCheckpoint | null> {
    const rows = await this.db
      .select()
      .from(pgSchema.jobSemanticCheckpointsPostgres)
      .where(
        and(
          jobScopeClause(input),
          eq(pgSchema.jobSemanticCheckpointsPostgres.sequence, input.sequence),
        ),
      )
      .limit(1);
    return rows[0] ? toCheckpoint(rows[0]) : null;
  }
}

function jobScopeClause(input: {
  appId: string;
  agentId: string;
  jobId: string;
}) {
  return and(
    eq(pgSchema.jobSemanticCheckpointsPostgres.appId, input.appId),
    eq(pgSchema.jobSemanticCheckpointsPostgres.agentId, input.agentId),
    eq(pgSchema.jobSemanticCheckpointsPostgres.jobId, input.jobId),
  );
}

function normalizePayload(
  payload: JobSemanticCheckpointPayload,
): JobSemanticCheckpointPayload {
  if (
    !payload ||
    typeof payload.safePhase !== 'string' ||
    !payload.safePhase.trim() ||
    payload.safePhase.length > MAX_SAFE_PHASE_CHARS
  ) {
    throw new InvalidJobSemanticCheckpointError('safePhase is invalid.');
  }
  if (
    typeof payload.nextAction !== 'string' ||
    !payload.nextAction.trim() ||
    payload.nextAction.length > MAX_NEXT_ACTION_CHARS
  ) {
    throw new InvalidJobSemanticCheckpointError('nextAction is invalid.');
  }
  if (
    !Number.isSafeInteger(payload.cumulativeRuntimeMs) ||
    payload.cumulativeRuntimeMs < 0
  ) {
    throw new InvalidJobSemanticCheckpointError(
      'cumulativeRuntimeMs must be a non-negative safe integer.',
    );
  }
  if (
    !Array.isArray(payload.artifactRefs) ||
    payload.artifactRefs.length > MAX_ARTIFACT_REFS
  ) {
    throw new InvalidJobSemanticCheckpointError('artifactRefs is invalid.');
  }
  const seen = new Set<string>();
  const artifactRefs = payload.artifactRefs.map((reference) => {
    if (
      !reference ||
      typeof reference.artifactId !== 'string' ||
      !reference.artifactId.trim() ||
      typeof reference.contentHash !== 'string' ||
      !reference.contentHash.startsWith('sha256:') ||
      typeof reference.kind !== 'string' ||
      !reference.kind.trim()
    ) {
      throw new InvalidJobSemanticCheckpointError(
        'Each artifact reference needs an id, sha256 hash, and kind.',
      );
    }
    if (seen.has(reference.artifactId)) {
      throw new InvalidJobSemanticCheckpointError(
        `Artifact ${reference.artifactId} is referenced more than once.`,
      );
    }
    seen.add(reference.artifactId);
    return {
      artifactId: reference.artifactId,
      contentHash: reference.contentHash,
      kind: reference.kind,
    };
  });
  return {
    safePhase: payload.safePhase.trim(),
    artifactRefs,
    evaluatorInvocationRef: optionalReference(payload.evaluatorInvocationRef),
    pendingInteractionRef: optionalReference(payload.pendingInteractionRef),
    nextAction: payload.nextAction.trim(),
    cumulativeRuntimeMs: payload.cumulativeRuntimeMs,
  };
}

function optionalReference(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  if (!value.trim() || value.length > 512) {
    throw new InvalidJobSemanticCheckpointError('Opaque reference is invalid.');
  }
  return value.trim();
}

async function assertArtifactScope(
  tx: Parameters<Parameters<CanonicalDb['transaction']>[0]>[0],
  input: {
    appId: string;
    agentId: string;
    jobId: string;
    payload: JobSemanticCheckpointPayload;
  },
) {
  if (input.payload.artifactRefs.length === 0) return;
  const ids = input.payload.artifactRefs.map((ref) => ref.artifactId);
  const rows = await tx
    .select()
    .from(pgSchema.fileArtifactsPostgres)
    .where(inArray(pgSchema.fileArtifactsPostgres.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const expectedScope = jobArtifactScope(input.jobId);
  for (const reference of input.payload.artifactRefs) {
    const row = byId.get(reference.artifactId);
    if (
      !row ||
      row.deletedAt !== null ||
      row.appId !== input.appId ||
      row.agentId !== input.agentId ||
      row.virtualScope !== expectedScope ||
      row.contentHash !== reference.contentHash
    ) {
      throw new InvalidJobSemanticCheckpointError(
        `Artifact ${reference.artifactId} is not an immutable artifact in this job.`,
      );
    }
  }
}

function checkpointHash(
  checkpoint: Omit<JobSemanticCheckpoint, 'payloadHash' | 'createdAt'>,
) {
  return `sha256:${stableSha256Json(checkpoint)}`;
}

function toCheckpoint(row: CheckpointRow): JobSemanticCheckpoint {
  if (!MILESTONES.has(row.milestone)) {
    throw new CorruptJobSemanticCheckpointError(row.id);
  }
  const payload = normalizePayload(
    row.payloadJson as JobSemanticCheckpointPayload,
  );
  const checkpointWithoutHash = {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    jobId: row.jobId,
    runId: row.runId,
    sequence: row.sequence,
    workerInstanceId: row.workerInstanceId,
    fencingVersion: row.fencingVersion,
    milestone: row.milestone as JobSemanticCheckpointMilestone,
    payload,
    createdAt: row.createdAt,
  };
  const expectedHash = checkpointHash({
    id: checkpointWithoutHash.id,
    appId: checkpointWithoutHash.appId,
    agentId: checkpointWithoutHash.agentId,
    jobId: checkpointWithoutHash.jobId,
    runId: checkpointWithoutHash.runId,
    sequence: checkpointWithoutHash.sequence,
    workerInstanceId: checkpointWithoutHash.workerInstanceId,
    fencingVersion: checkpointWithoutHash.fencingVersion,
    milestone: checkpointWithoutHash.milestone,
    payload: checkpointWithoutHash.payload,
  });
  if (row.payloadHash !== expectedHash) {
    throw new CorruptJobSemanticCheckpointError(row.id);
  }
  return {
    ...checkpointWithoutHash,
    payloadHash: row.payloadHash,
  };
}
