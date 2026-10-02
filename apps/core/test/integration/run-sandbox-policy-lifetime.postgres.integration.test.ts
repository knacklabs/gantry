import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRuntimeHomeFixture } from '../harness/runtime-home-fixture.js';
import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';
import type { RunAgentOptions } from '@core/runtime/agent-spawn-types.js';

// Fix owner: finished-runs-keep-their-sandbox-policie.
// Real host spawning and finalization own this contract; only the model
// execution adapter and its credential broker are replaced at their edges.
const suite = process.env.GANTRY_TEST_DATABASE_URL ? describe : describe.skip;

suite('run sandbox policy lifetime', () => {
  let home: ReturnType<typeof createRuntimeHomeFixture>;
  let runtime: PostgresIntegrationRuntime;
  let spawnAgent: typeof import('@core/runtime/agent-spawn.js').spawnAgent;
  let readPolicy: typeof import('@core/runtime/async-command-sandbox-policy.js').readAsyncCommandSandboxPolicy;
  let options: RunAgentOptions;

  beforeAll(async () => {
    home = createRuntimeHomeFixture({
      prefix: 'gantry-policy-lifetime-',
      mutateSettings: (settings) => {
        settings.runtime.sandbox.provider = 'direct';
      },
    });
    vi.stubEnv('GANTRY_HOME', home.runtimeHome);
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      Buffer.alloc(32, 17).toString('base64'),
    );
    vi.resetModules();
    const { createPostgresIntegrationRuntime } =
      await import('../harness/postgres-integration-runtime.js');
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'run_policy_lifetime',
    });
    const { _setRuntimeStorageForTest } =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    _setRuntimeStorageForTest(runtime.storageRuntime);
    ({ spawnAgent } = await import('@core/runtime/agent-spawn.js'));
    ({ readAsyncCommandSandboxPolicy: readPolicy } =
      await import('@core/runtime/async-command-sandbox-policy.js'));
    const { DirectRunnerSandboxProvider } =
      await import('@core/adapters/sandbox/runner-sandbox-provider.js');
    options = {
      timeoutMs: 20_000,
      runnerSandboxProvider: new DirectRunnerSandboxProvider(),
      credentialBroker: {
        getInjection: async () => ({
          env: {},
          applied: true,
          brokerProfile: 'gantry',
        }),
        healthCheck: async () => ({ status: 'pass', message: 'Ready' }),
        getCapabilities: () => ({
          profile: 'gantry',
          supportsAgentBinding: true,
          returnsRawSecrets: false,
        }),
      },
      executionAdapter: {
        id: 'anthropic:claude-agent-sdk',
        prepare: async ({ input }) => ({
          providerId: 'anthropic:claude-agent-sdk',
          runnerPath: process.execPath,
          runnerArgs: [
            '--input-type=module',
            '-e',
            `import fs from 'node:fs';
             process.stdin.resume();
             process.stdin.on('end', () => {
               const finish = () => {
                 console.log('---GANTRY_OUTPUT_START---');
                 console.log(JSON.stringify({ status: ${JSON.stringify(input.prompt)}, result: 'Finished' }));
                 console.log('---GANTRY_OUTPUT_END---');
               };
               if (${Boolean(input.parentTaskId)}) {
                 const watcher = fs.watch(${JSON.stringify(home.runtimeHome)}, (_, name) => {
                   if (name === 'release' && fs.existsSync(${JSON.stringify(path.join(home.runtimeHome, 'release'))})) {
                     watcher.close();
                     finish();
                   }
                 });
                 console.log('child ready');
               } else finish();
             });`,
          ],
          env: {},
          protectedFilesystemPaths: [path.join(home.runtimeHome, 'private')],
          runtimeDetails: [],
          cleanup: () => {},
        }),
      },
    };
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
    home?.cleanup();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(['success', 'error'])(
    'releases a finished %s run policy while a child task stays live',
    async (status) => {
      const releasePath = path.join(home.runtimeHome, 'release');
      fs.rmSync(releasePath, { force: true });
      const group = {
        name: 'Policy lifetime',
        folder: 'main',
        trigger: 'Gantry',
        added_at: new Date().toISOString(),
      };
      const input = {
        appId: 'default',
        agentId: 'agent:main',
        workspaceFolder: 'main',
        chatJid: 'conversation:policy-lifetime',
        runtime: 'worker' as const,
        model: 'fable',
        prompt: 'success',
      };
      let childHandle = '';
      let parentHandle = '';
      const ready = Promise.withResolvers<void>();
      const child = spawnAgent(
        group,
        { ...input, parentTaskId: 'task:parent' },
        (proc, handle) => {
          childHandle = handle;
          proc.stdout?.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('child ready')) ready.resolve();
          });
        },
        undefined,
        options,
      );
      void child.then(() =>
        ready.reject(new Error('Child ended before ready')),
      );
      try {
        await ready.promise;
        const childPolicy = readPolicy({
          sourceAgentFolder: 'main',
          runHandle: childHandle,
        });
        expect(childPolicy).toMatchObject({
          protectedReadPaths: [path.join(home.runtimeHome, 'private')],
        });
        const parent = await spawnAgent(
          group,
          { ...input, prompt: status },
          (_, handle) => {
            parentHandle = handle;
            expect(
              readPolicy({ sourceAgentFolder: 'main', runHandle: handle }),
            ).toBeDefined();
          },
          undefined,
          options,
        );
        expect(parent.status).toBe(status);
        expect(parentHandle).not.toBe(childHandle);
        expect(
          readPolicy({ sourceAgentFolder: 'main', runHandle: parentHandle }),
        ).toBeUndefined();
        expect(
          readPolicy({ sourceAgentFolder: 'main', runHandle: childHandle }),
        ).toEqual(childPolicy);
      } finally {
        fs.writeFileSync(releasePath, 'finish');
        expect((await child).status).toBe('success');
      }
      expect(
        readPolicy({ sourceAgentFolder: 'main', runHandle: childHandle }),
      ).toBeUndefined();
    },
    30_000,
  );
});
