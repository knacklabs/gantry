import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

const cleanupDocs = [
  'docs/architecture/autonomous-jobs.md',
  'docs/architecture/overview.md',
  'docs/sdk/api-reference.md',
  'docs/SPEC.md',
] as const;

const legacyJobNotificationTerms = [
  'linked_sessions',
  'linkedSessions',
  'notificationTarget',
  'deliver_to',
  'deliverTo',
  'notifyLinkedSessions',
] as const;

const allowedLegacyReferenceFiles = new Set([
  'apps/core/src/domain/types.ts',
  'apps/core/src/domain/repositories/ops-repo.ts',
  'apps/core/src/jobs/ipc-scheduler-create-handlers.ts',
  'apps/core/src/jobs/ipc-scheduler-mutate-handlers.ts',
  'apps/core/src/runtime/ipc-task-parsing.ts',
  'apps/core/src/runner/mcp/tools/scheduler-tool-helpers.ts',
  'apps/core/src/adapters/storage/postgres/services/canonical-job-ops-service.ts',
  'apps/core/src/adapters/storage/postgres/schema/migrations/0000_initial.sql',
  'apps/core/src/adapters/storage/postgres/schema/migrations/0040_jobs_target_execution_context_notification_routes.sql',
]);

function collectFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(absolute));
      continue;
    }
    out.push(absolute);
  }
  return out;
}

describe('job notification cleanup', () => {
  it('keeps legacy job notification fields out of active runtime logic', () => {
    const sourceRoot = path.join(repoRoot, 'apps/core/src');
    const offenders: string[] = [];

    for (const absolutePath of collectFiles(sourceRoot)) {
      if (!/\.(ts|sql)$/.test(absolutePath)) continue;
      const relativePath = path.relative(repoRoot, absolutePath);
      const source = fs.readFileSync(absolutePath, 'utf8');
      const hasLegacyTerm = legacyJobNotificationTerms.some((term) =>
        source.includes(term),
      );
      if (!hasLegacyTerm) continue;
      if (!allowedLegacyReferenceFiles.has(relativePath)) {
        offenders.push(relativePath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps canonical job mapping free of legacy linked-session reads/writes', () => {
    const source = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/adapters/storage/postgres/services/canonical-job-ops-service.ts',
      ),
      'utf8',
    );

    expect(source).not.toContain('job.linked_sessions');
    expect(source).not.toContain('normalizeString(job.linked_sessions');
    expect(source).not.toContain('Array.isArray(job.linked_sessions)');
    expect(source).not.toContain('linked_sessions: notificationRoutes.map');
  });

  it('fails closed for legacy linked-session route migration inputs', () => {
    const migration = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/adapters/storage/postgres/schema/migrations/0040_jobs_target_execution_context_notification_routes.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('rejects legacy linkedSessions');
    expect(migration).toContain(
      "COALESCE(NULLIF(target_json, '')::jsonb ? 'linkedSessions', false)",
    );
    expect(migration).not.toContain(
      "jsonb_array_elements_text(normalized.target -> 'linkedSessions')",
    );
  });

  it('keeps legacy job notification fields out of active docs', () => {
    for (const relativePath of cleanupDocs) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      for (const term of legacyJobNotificationTerms) {
        expect(source).not.toContain(term);
      }
    }
  });
});
