import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/core/src/adapters/storage/postgres/schema/schema.ts',
  out: './apps/core/src/adapters/storage/postgres/schema/migrations',
  migrations: {
    prefix: 'timestamp',
  },
});
