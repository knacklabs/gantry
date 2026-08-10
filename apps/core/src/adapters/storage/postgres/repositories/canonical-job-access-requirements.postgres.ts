import { and, eq, sql } from 'drizzle-orm';

import type { JobAccessRequirementAppend } from '../../../../domain/repositories/ops-repo.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { jsonb } from './canonical-graph-repository.postgres.js';

export async function appendCanonicalJobAccessRequirement(
  db: CanonicalDb,
  input: JobAccessRequirementAppend,
): Promise<boolean> {
  const jobs = pgSchema.canonicalJobsPostgres;
  const rows = await db
    .update(jobs)
    .set({
      targetJson: sql`jsonb_set(
        ${jobs.targetJson},
        '{accessRequirements}',
        coalesce(${jobs.targetJson} -> 'accessRequirements', '[]'::jsonb)
          || ${jsonb([input.requirement])},
        true
      )`,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.updatedAt, input.expectedUpdatedAt),
      ),
    )
    .returning({ id: jobs.id });
  return rows.length === 1;
}
