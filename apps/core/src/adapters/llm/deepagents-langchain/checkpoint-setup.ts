import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

const SETUP_POOL_MAX_CONNECTIONS = 1;
export const DEEPAGENTS_CHECKPOINT_PACKAGE_NAME =
  '@langchain/langgraph-checkpoint-postgres';

const setupByTarget = new Map<string, Promise<void>>();

export async function ensureDeepAgentsCheckpointSchema(input: {
  databaseUrl: string;
  schema: string;
  requirePreprovisionedSchema?: boolean;
}): Promise<void> {
  const databaseUrl = input.databaseUrl.trim();
  const schema = input.schema.trim();
  if (!databaseUrl || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(
      'DeepAgents checkpoint schema setup requires Postgres connection and schema.',
    );
  }
  const key = `${databaseUrl}\0${schema}\0${Boolean(input.requirePreprovisionedSchema)}`;
  let setup = setupByTarget.get(key);
  if (!setup) {
    setup = setupDeepAgentsCheckpointSchema({
      databaseUrl,
      schema,
      requirePreprovisionedSchema: input.requirePreprovisionedSchema,
    }).catch((error) => {
      setupByTarget.delete(key);
      throw error;
    });
    setupByTarget.set(key, setup);
  }
  await setup;
}

async function setupDeepAgentsCheckpointSchema(input: {
  databaseUrl: string;
  schema: string;
  requirePreprovisionedSchema?: boolean;
}): Promise<void> {
  const pool = new pg.Pool({
    connectionString: input.databaseUrl,
    max: SETUP_POOL_MAX_CONNECTIONS,
  });
  // The official saver always issues CREATE SCHEMA, which needs database-wide
  // CREATE even when the schema exists. Intercept only that exact statement.
  // Table creation and every official migration still execute unchanged.
  const setupPool = new Proxy(pool, {
    get(target, property) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, member) {
            if (member === 'query')
              return async (...args: unknown[]) => {
                if (
                  args[0] === `CREATE SCHEMA IF NOT EXISTS "${input.schema}"`
                ) {
                  const result = await connection.query(
                    'SELECT pg_get_userbyid(nspowner) = current_user AS owned FROM pg_namespace WHERE nspname = $1',
                    [input.schema],
                  );
                  if (result.rows[0]?.owned === true) {
                    return {
                      rows: [],
                      rowCount: 0,
                      command: 'CREATE',
                      oid: 0,
                      fields: [],
                    };
                  }
                  if (input.requirePreprovisionedSchema) {
                    throw new Error(
                      'DeepAgents checkpoint schema must be preprovisioned and owned by the runtime database role.',
                    );
                  }
                }
                return Reflect.apply(connection.query, connection, args);
              };
            const value = Reflect.get(connection, member);
            return typeof value === 'function' ? value.bind(connection) : value;
          },
        });
      };
    },
  });
  const saver = new PostgresSaver(setupPool, undefined, {
    schema: input.schema,
  });
  try {
    await saver.setup();
  } finally {
    await saver.end().catch(() => {});
  }
}
