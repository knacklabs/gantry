import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.resolve(
    'apps/core/src/adapters/storage/postgres/schema/migrations/20260821000000_agent_tool_binding_person_compat.sql',
  ),
  'utf8',
);

describe('agent tool binding person compatibility migration', () => {
  it('is safe for both legacy and already-upgraded deployments', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "person_id" text');
    expect(migration).toContain(
      "conname = 'agent_tool_bindings_app_person_fk'",
    );
    expect(migration).toContain('ranked_agent_tool_bindings');
    expect(migration).toContain(
      'CASE WHEN "status" = \'active\' THEN 0 ELSE 1 END',
    );
    expect(migration).toContain('WHERE binding_rank > 1');
    expect(migration).toContain("conname = 'idx_agent_tool_bindings_unique'");
    expect(migration).toContain('UNIQUE NULLS NOT DISTINCT');
  });
});
