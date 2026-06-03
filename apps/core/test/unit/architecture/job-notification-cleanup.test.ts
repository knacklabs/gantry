import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

const cleanupDocs = [
  'docs/architecture/autonomous-jobs.md',
  'docs/architecture/overview.md',
  'docs/architecture/agent-runtime.md',
  'docs/architecture/canonical-domain-model.md',
  'docs/architecture/memory-continuity-fixes-plan.md',
  'docs/architecture/refactor-gap-closure-plan.md',
  'docs/sdk/api-reference.md',
  'docs/SPEC.md',
  'docs/MEMORY.md',
] as const;

const legacyJobNotificationTerms = [
  'linked_sessions',
  'linkedSessions',
  'notificationTarget',
  'deliver_to',
  'deliverTo',
  'notifyLinkedSessions',
] as const;

const unsupportedSchedulerRoutingAliases = [
  'linked_sessions',
  'linkedSessions',
  'notificationTarget',
  'deliver_to',
  'deliverTo',
  'threadId',
  'sessionId',
  'groupScope',
  'group_scope',
] as const;

// Group->workspace rename: legacy execution-scope tokens that must not
// reappear in active docs.
const workspaceRenameLegacyTokens = [
  'groupScope',
  'group_scope',
  'groupFolder',
  'group_folder',
  'GANTRY_GROUP_FOLDER',
  'Group Folder',
  'group folder',
  'idx_jobs_target_group_scope',
  'executionContext.groupScope',
] as const;

const allowedLegacyReferenceFiles = new Set([
  'apps/core/src/jobs/ipc-scheduler-create-handlers.ts',
  'apps/core/src/jobs/ipc-scheduler-mutate-handlers.ts',
  'apps/core/src/runtime/ipc-task-parsing.ts',
  'apps/core/src/runner/mcp/tools/scheduler-tool-helpers.ts',
  'apps/core/src/adapters/storage/postgres/schema/migrations/0000_initial.sql',
  'apps/core/src/adapters/storage/postgres/schema/migrations/0040_jobs_target_execution_context_notification_routes.sql',
  'apps/core/src/adapters/storage/postgres/schema/migrations/0071_jobs_target_workspace_key_cutover.sql',
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

function extractConstSetItems(source: string, name: string): string[] {
  const match = new RegExp(
    `const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`,
  ).exec(source);
  if (!match) throw new Error(`Could not find ${name}`);
  return Array.from(match[1].matchAll(/'([^']+)'/g), (item) => item[1]);
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

  it('keeps scheduler MCP mutation tools from accepting legacy routing aliases', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'apps/core/src/runner/mcp/tools/scheduler.ts'),
      'utf8',
    );

    const upsertKeys = extractConstSetItems(
      source,
      'SCHEDULER_UPSERT_ARG_KEYS',
    );
    const updateKeys = extractConstSetItems(
      source,
      'SCHEDULER_UPDATE_ARG_KEYS',
    );

    for (const alias of unsupportedSchedulerRoutingAliases) {
      expect(upsertKeys).not.toContain(alias);
      expect(updateKeys).not.toContain(alias);
    }
  });

  it('keeps runtime scheduler IPC legacy aliases reject-only', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'apps/core/src/runtime/ipc-task-parsing.ts'),
      'utf8',
    );

    const rejectGuardIndex = source.indexOf(
      'assertNoUnsupportedSchedulerJobTaskFields(raw, type);',
    );
    const parsedObjectIndex = source.indexOf('const parsed: TaskIpcData');

    expect(rejectGuardIndex).toBeGreaterThanOrEqual(0);
    expect(parsedObjectIndex).toBeGreaterThan(rejectGuardIndex);
    expect(source).not.toContain('raw.linkedSessions');
    expect(source).not.toContain('raw.notificationTarget');
    expect(source).not.toContain('raw.deliverTo');
    expect(source).not.toContain('raw.sessionId');
  });

  it('keeps legacy job notification fields out of active docs', () => {
    for (const relativePath of cleanupDocs) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      for (const term of legacyJobNotificationTerms) {
        expect(source).not.toContain(term);
      }
    }
  });

  it('keeps legacy group execution-scope tokens out of active docs', () => {
    const docsRoot = path.join(repoRoot, 'docs');
    const offenders: string[] = [];

    for (const absolutePath of collectFiles(docsRoot)) {
      if (!/\.md$/.test(absolutePath)) continue;
      const relativePath = path.relative(repoRoot, absolutePath);
      const source = fs.readFileSync(absolutePath, 'utf8');
      const hit = workspaceRenameLegacyTokens.find((token) =>
        source.includes(token),
      );
      if (hit) offenders.push(`${relativePath} (${hit})`);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the legacy group execution-scope aliases reject-only in active source', () => {
    const rejectOnlySources = [
      'apps/core/src/control/server/routes/jobs.ts',
      'apps/core/src/runner/mcp/tools/scheduler.ts',
      'apps/core/src/runner/mcp/tools/scheduler-tool-helpers.ts',
      'apps/core/src/runtime/ipc-task-parsing.ts',
      'apps/core/src/runner/mcp/context.ts',
    ];

    for (const relativePath of rejectOnlySources) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).toContain('is no longer');
    }
  });
});
