import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const runtimeWorkerInventorySnapshotsPostgres = pgTable(
  'runtime_worker_inventory_snapshots',
  {
    appId: text('app_id').notNull(),
    instanceId: text('instance_id').notNull(),
    hostname: text('hostname').notNull(),
    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    warmPoolJson: jsonb('warm_pool_json').notNull(),
    queueJson: jsonb('queue_json').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'runtime_worker_inventory_snapshots_pkey',
      columns: [table.appId, table.instanceId],
    }),
    heartbeatIdx: index('idx_runtime_worker_inventory_heartbeat').on(
      table.appId,
      table.lastHeartbeatAt,
    ),
  }),
);
