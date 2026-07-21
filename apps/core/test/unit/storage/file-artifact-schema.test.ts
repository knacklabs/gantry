import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

describe('file artifact schema', () => {
  it('stores file artifacts as virtual metadata plus backend refs', () => {
    const schema = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/adapters/storage/postgres/schema/file-artifacts.ts',
      ),
      'utf8',
    );
    const migration = fs.readFileSync(
      path.join(
        repoRoot,
        'apps/core/src/adapters/storage/postgres/schema/migrations/0000_ponytail_baseline.sql',
      ),
      'utf8',
    );

    expect(schema).toContain("'file_artifacts'");
    expect(schema).toContain('.references(() => appsPostgres.id');
    expect(schema).toContain('.references(() => agentsPostgres.id');
    expect(schema).toContain("virtualScope: text('virtual_scope').notNull()");
    expect(schema).toContain("virtualPath: text('virtual_path').notNull()");
    expect(schema).toContain("version: integer('version').notNull()");
    expect(schema).toContain("contentHash: text('content_hash').notNull()");
    expect(migration).toContain('CREATE TABLE "file_artifacts"');
    expect(migration).toContain(
      'FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade',
    );
    expect(migration).toContain('idx_file_artifacts_version_unique');
  });
});
