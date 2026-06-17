import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

const SETUP_POOL_MAX_CONNECTIONS = 1;
export const DEEPAGENTS_CHECKPOINT_PACKAGE_NAME =
  '@langchain/langgraph-checkpoint-postgres';

const setupByTarget = new Map<string, Promise<void>>();

export async function ensureDeepAgentsCheckpointSchema(input: {
  databaseUrl: string;
  schema: string;
}): Promise<void> {
  const databaseUrl = input.databaseUrl.trim();
  const schema = input.schema.trim();
  if (!databaseUrl || !schema) {
    throw new Error(
      'DeepAgents checkpoint schema setup requires Postgres connection and schema.',
    );
  }
  const key = `${databaseUrl}\0${schema}`;
  let setup = setupByTarget.get(key);
  if (!setup) {
    setup = setupDeepAgentsCheckpointSchema({ databaseUrl, schema }).catch(
      (error) => {
        setupByTarget.delete(key);
        throw error;
      },
    );
    setupByTarget.set(key, setup);
  }
  await setup;
}

async function setupDeepAgentsCheckpointSchema(input: {
  databaseUrl: string;
  schema: string;
}): Promise<void> {
  const pool = new pg.Pool({
    connectionString: input.databaseUrl,
    max: SETUP_POOL_MAX_CONNECTIONS,
  });
  const saver = new PostgresSaver(pool, undefined, { schema: input.schema });
  try {
    await saver.setup();
  } finally {
    await saver.end().catch(() => {});
  }
}
