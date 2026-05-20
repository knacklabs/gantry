import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('canonical Postgres persistence cut', () => {
  const adapterRoot = path.resolve('apps/core/src/adapters/storage/postgres');
  const browserDriverPackagePattern = `${'play'}wright-core`;

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
        new RegExp(
          `from ['"](node:|@anthropic-ai|openai|@google|@slack|grammy|${browserDriverPackagePattern}|dockerode)`,
        ),
      );
    }
  });

  it('uses the storage adapter path for active Postgres implementation', () => {
    expect(fs.existsSync(adapterRoot)).toBe(true);
    expect(
      fs.existsSync(path.resolve('apps/core/src/infrastructure/postgres')),
    ).toBe(false);
  });

  it('keeps application services behind repository ports', () => {
    const root = path.resolve('apps/core/src/application');
    const files = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));

    for (const file of files) {
      const filePath = path.join(file.parentPath, file.name);
      const source = fs.readFileSync(filePath, 'utf8');
      expect(source).not.toMatch(
        /from ['"].*adapters\/storage\/postgres\/schema/,
      );
    }
  });

  it('splits active schema by canonical responsibility', () => {
    for (const file of [
      'apps',
      'agents',
      'providers',
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
    expect(schema).toContain("providerId: text('provider')");
    expect(schema).toContain(
      "providerConnectionId: text('provider_connection_id')",
    );
    expect(schema).toContain("externalMessageId: text('external_message_id')");
    expect(migration).toContain('idx_messages_external_redelivery_unique');
    expect(migration).toContain('WHERE external_message_id IS NOT NULL');
  });

  it('records repository contract indexes and permission audit context', () => {
    const migration = fs.readFileSync(
      path.join(
        adapterRoot,
        'schema/migrations/0010_repository_contract_indexes.sql',
      ),
      'utf8',
    );
    const permissionsSchema = fs.readFileSync(
      path.join(adapterRoot, 'schema/permissions.ts'),
      'utf8',
    );

    expect(migration).toContain('actor_context_json');
    expect(migration).toContain('action_preview');
    expect(migration).toContain("COALESCE(thread_id, '')");
    expect(migration).toContain('idx_agent_sessions_deterministic_key');
    expect(permissionsSchema).toContain(
      "actorContextJson: text('actor_context_json')",
    );
    expect(permissionsSchema).toContain(
      "actionPreview: text('action_preview')",
    );
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
    expect(schema).toContain("metadataJson: jsonb('metadata_json')");
    expect(schema).toContain('agentSessionSummariesPostgres');
    expect(repository).toContain('latestProviderSessionId: sessionId');
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
    expect(schema).toContain("valueJson: jsonb('value_json').notNull()");
    expect(schema).toContain("sourceRefJson: jsonb('source_ref_json')");
    expect(aggregateSchema).not.toContain('memorySubjectsPostgres');
  });

  it('seeds deterministic default runtime rows after migration', () => {
    const seed = fs.readFileSync(path.join(adapterRoot, 'seeds.ts'), 'utf8');
    const storage = fs.readFileSync(
      path.join(adapterRoot, 'storage-service.ts'),
      'utf8',
    );

    expect(seed).toContain("DEFAULT_APP_ID = 'default'");
    expect(seed).toContain("DEFAULT_AGENT_ID = 'agent:main_agent'");
    expect(seed).toContain(`provider: 'anth${'ropic'}'`);
    expect(seed).toContain('permission-policy:default');
    expect(seed).toContain('sandbox-profile:local-dev');
    expect(seed).toContain('tool:Browser');
    expect(seed).not.toContain(['anthropic', 'sdk'].join('_'));
    expect(seed).not.toContain('sdkTool(');
    for (const providerNativeTool of [
      'tool:Agent',
      'tool:Bash',
      'tool:Read',
      'tool:Write',
      'tool:WebSearch',
    ]) {
      expect(seed).not.toContain(providerNativeTool);
    }
    expect(seed).not.toContain('SubscribeMcpResource');
    expect(seed).not.toContain('SubscribePolling');
    expect(seed).toContain('skill:memory');
    expect(storage).toContain('seedDefaultRuntimeData(this.db)');
  });
});
