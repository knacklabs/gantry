import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('canonical domain cutover', () => {
  it('keeps canonical domain source free of provider/runtime imports', () => {
    const root = path.resolve('apps/core/src/domain');
    const files = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));

    for (const file of files) {
      const filePath = path.join(file.parentPath, file.name);
      const source = fs.readFileSync(filePath, 'utf8');
      expect(source).not.toMatch(
        /from ['"].*(adapters|runtime|control|cli|infrastructure|runner)\//,
      );
      expect(source).not.toMatch(
        /from ['"](node:|@anthropic-ai|openai|@google|@slack|grammy|playwright|dockerode)/,
      );
    }
  });

  it('records the destructive schema cutover migration', () => {
    const migration = fs.readFileSync(
      path.resolve(
        'apps/core/src/infrastructure/postgres/schema/migrations/0008_canonical_domain_schema_cutover.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('DROP TABLE IF EXISTS registered_groups');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS apps');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS agent_channel_bindings',
    );
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS agent_runs');
  });

  it('lets canonical job updates change running job status and leases', () => {
    const source = fs.readFileSync(
      path.resolve(
        'apps/core/src/infrastructure/postgres/schema/canonical-ops-repo.postgres.ts',
      ),
      'utf8',
    );
    const updateJobSource = source.slice(
      source.indexOf('async updateJob'),
      source.indexOf('async deleteJob'),
    );

    expect(updateJobSource).toContain('UPDATE jobs SET');
    expect(updateJobSource).toContain('status = $7');
    expect(updateJobSource).toContain('lease_run_id = $16');
    expect(updateJobSource).toContain('lease_expires_at = $17');
    expect(updateJobSource).not.toContain('this.upsertJob');
  });
});
