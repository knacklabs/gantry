import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('canonical Postgres persistence cut', () => {
  const adapterRoot = path.resolve('apps/core/src/adapters/storage/postgres');

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

  it('uses the storage adapter path for active Postgres implementation', () => {
    expect(fs.existsSync(adapterRoot)).toBe(true);
    expect(
      fs.existsSync(path.resolve('apps/core/src/infrastructure/postgres')),
    ).toBe(false);
  });

  it('splits active schema by canonical responsibility', () => {
    for (const file of [
      'apps',
      'agents',
      'channels',
      'conversations',
      'messages',
      'sessions',
      'runs',
      'jobs',
      'memory',
      'permissions',
      'tools',
      'skills',
      'sandbox',
      'browser',
      'events',
      'index',
    ]) {
      expect(
        fs.existsSync(path.join(adapterRoot, 'schema', `${file}.ts`)),
      ).toBe(true);
    }
  });

  it('records the destructive canonical persistence migration', () => {
    const migration = fs.readFileSync(
      path.join(
        adapterRoot,
        'schema/migrations/0009_canonical_persistence_adapter_cut.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('DROP TABLE IF EXISTS registered_groups');
    expect(migration).toContain('CREATE TABLE messages');
    expect(migration).toContain('CREATE TABLE users');
    expect(migration).toContain('CREATE TABLE provider_sessions');
    expect(migration).toContain('CREATE TABLE job_runs');
    expect(migration).toContain('CREATE TABLE permission_audit_events');
    expect(migration).toContain('CREATE TABLE agent_tool_bindings');
    expect(migration).toContain('CREATE TABLE agent_skill_bindings');
  });

  it('stores message provider redelivery idempotency fields', () => {
    const schema = fs.readFileSync(
      path.join(adapterRoot, 'schema/messages.ts'),
      'utf8',
    );
    const migration = fs.readFileSync(
      path.join(
        adapterRoot,
        'schema/migrations/0009_canonical_persistence_adapter_cut.sql',
      ),
      'utf8',
    );

    expect(schema).toContain("'messages'");
    expect(schema).toContain("channelProvider: text('channel_provider')");
    expect(schema).toContain(
      "channelInstallationId: text('channel_installation_id')",
    );
    expect(schema).toContain("externalMessageId: text('external_message_id')");
    expect(migration).toContain('idx_messages_external_redelivery_unique');
    expect(migration).toContain('WHERE external_message_id IS NOT NULL');
  });

  it('keeps sessions provider-neutral and provider resume metadata explicit', () => {
    const schema = fs.readFileSync(
      path.join(adapterRoot, 'schema/sessions.ts'),
      'utf8',
    );
    const repository = fs.readFileSync(
      path.join(
        adapterRoot,
        'repositories/canonical-session-repository.postgres.ts',
      ),
      'utf8',
    );

    expect(schema).toContain(
      "latestProviderSessionId: text('latest_provider_session_id')",
    );
    expect(schema).toContain("provider: text('provider').notNull()");
    expect(schema).toContain(
      "externalSessionId: text('external_session_id').notNull()",
    );
    expect(schema).toContain("artifactRef: text('artifact_ref').notNull()");
    expect(repository).toContain('latestProviderSessionId: input.sessionId');
  });

  it('flattens canonical memory subject fields onto memory items', () => {
    const schema = fs.readFileSync(
      path.join(adapterRoot, 'schema/memory.ts'),
      'utf8',
    );
    const aggregateSchema = fs.readFileSync(
      path.join(adapterRoot, 'schema/schema.ts'),
      'utf8',
    );

    expect(schema).toContain("'memory_items'");
    expect(schema).toContain("subjectType: text('subject_type').notNull()");
    expect(schema).toContain("conversationId: text('conversation_id')");
    expect(aggregateSchema).not.toContain('memorySubjectsPostgres');
  });

  it('seeds deterministic default runtime rows after migration', () => {
    const seed = fs.readFileSync(path.join(adapterRoot, 'seeds.ts'), 'utf8');
    const storage = fs.readFileSync(
      path.join(adapterRoot, 'storage-service.ts'),
      'utf8',
    );

    expect(seed).toContain("DEFAULT_APP_ID = 'default'");
    expect(seed).toContain("DEFAULT_AGENT_ID = 'agent:personal'");
    expect(seed).toContain("provider: 'anthropic'");
    expect(seed).toContain('permission-policy:default');
    expect(seed).toContain('sandbox-profile:local-dev');
    expect(seed).toContain('tool:memory');
    expect(seed).toContain('skill:memory');
    expect(storage).toContain('seedDefaultRuntimeData(this.db)');
  });
});
