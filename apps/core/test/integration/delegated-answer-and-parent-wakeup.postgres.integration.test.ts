import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { IpcDeps } from '@core/runtime/ipc-domain-types.js';
import { ensureConfiguredAgent } from '@core/config/settings/runtime-settings.js';
import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';
import { hasPostgresIntegrationDatabase } from '../harness/postgres-integration-runtime.js';
import { createRuntimeHomeFixture } from '../harness/runtime-home-fixture.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const APP_ID = 'default';
const AGENT_ID = 'agent:main_agent';
const CHAT = 'conversation:delegated-answer';
const THREAD = 'thread:delegated-answer';
const ANSWER = 'First finding. Second finding. Final recommendation.';

// Fix-owned IPC regressions: the provider emits fragments; production owns
// accumulation, completion persistence and live admission of the parent result.
maybeDescribe(
  'delegated answers and parent wake-up through IPC (Postgres)',
  () => {
    let runtime: PostgresIntegrationRuntime;
    let home: ReturnType<typeof createRuntimeHomeFixture>;
    let deps: IpcDeps;
    let dispatch: typeof import('@core/jobs/ipc-handler.js').processTaskIpc;
    let parse: typeof import('@core/runtime/ipc-task-parsing.js').parseTaskIpcData;
    let auth: typeof import('@core/runtime/ipc-auth.js');
    let sign: typeof import('@core/infrastructure/ipc/request-signing.js').signIpcRequestPayload;
    let register: typeof import('@core/runtime/async-command-sandbox-policy.js').registerAsyncCommandSandboxPolicy;

    beforeAll(async () => {
      home = createRuntimeHomeFixture({
        mutateSettings(settings) {
          settings.credentialBroker.mode = 'none';
          settings.runtime.sandbox.provider = 'direct';
          ensureConfiguredAgent(settings, {
            agentId: 'main_agent',
            agentName: 'Main',
            agentFolder: 'main_agent',
          });
          settings.agents.main_agent!.defaultModel = 'haiku';
        },
      });
      vi.stubEnv('GANTRY_HOME', home.runtimeHome);
      vi.stubEnv(
        'SECRET_ENCRYPTION_KEY',
        Buffer.alloc(32, 23).toString('base64'),
      );
      vi.resetModules();
      const harness =
        await import('../harness/postgres-integration-runtime.js');
      runtime = await harness.createPostgresIntegrationRuntime({
        schemaPrefix: 'delegated_answer',
      });
      const store =
        await import('@core/adapters/storage/postgres/runtime-store.js');
      store._setRuntimeStorageForTest(runtime.storageRuntime);
      const now = new Date().toISOString();
      const delegation = (
        await runtime.repositories.tools.listTools({ appId: APP_ID as never })
      ).find((tool) => tool.name === 'AgentDelegation');
      if (!delegation) throw new Error('Delegation catalog entry missing');
      await runtime.repositories.tools.saveAgentToolBinding({
        id: 'binding:delegation' as never,
        appId: APP_ID as never,
        agentId: AGENT_ID as never,
        toolId: delegation.id,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      ({ processTaskIpc: dispatch } =
        await import('@core/jobs/ipc-handler.js'));
      ({ parseTaskIpcData: parse } =
        await import('@core/runtime/ipc-task-parsing.js'));
      auth = await import('@core/runtime/ipc-auth.js');
      ({ signIpcRequestPayload: sign } =
        await import('@core/infrastructure/ipc/request-signing.js'));
      ({ registerAsyncCommandSandboxPolicy: register } =
        await import('@core/runtime/async-command-sandbox-policy.js'));
      const { spawnAgent } = await import('@core/runtime/agent-spawn.js');
      const { DirectRunnerSandboxProvider } =
        await import('@core/adapters/sandbox/runner-sandbox-provider.js');
      const runnerPath = path.join(home.runtimeHome, 'provider.mjs');
      // Only the external provider is replaced. The child process and its stdout
      // framing, host runner, IPC dispatch and both database repositories are real.
      fs.writeFileSync(
        runnerPath,
        `
import fs from 'node:fs';
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const releasePath = request.prompt.match(/release=([^\\n]+)/)[1];
  const emit = result => {
    console.log('---GANTRY_OUTPUT_START---');
    console.log(JSON.stringify({ status: 'success', result }));
    console.log('---GANTRY_OUTPUT_END---');
  };
  emit('First finding. ');
  emit('Second finding. ');
  const finish = () => { emit('Final recommendation.'); watcher.close(); };
  const watcher = fs.watch(releasePath, finish);
  fs.writeFileSync(releasePath + '.ready', 'ready');
});
`,
      );
      deps = {
        opsRepository: runtime.ops,
        getAsyncTaskRepository: () => runtime.repositories.asyncTasks,
        getToolRepository: () => runtime.repositories.tools,
        getAgentRepository: () => runtime.repositories.agents,
        conversationRoutes: () => ({
          [CHAT]: {
            jid: CHAT,
            conversationId: CHAT,
            agentId: AGENT_ID,
            name: 'Delegation',
            folder: 'main_agent',
            trigger: '',
            added_at: now,
          },
        }),
        runAgent: spawnAgent,
        runnerSandboxProvider: new DirectRunnerSandboxProvider(),
        executionAdapter: {
          id: 'anthropic:claude-agent-sdk',
          async prepare() {
            return {
              providerId: 'anthropic:claude-agent-sdk',
              runnerPath,
              runnerArgs: [runnerPath],
              env: {},
              protectedFilesystemPaths: [],
              runtimeDetails: [],
              cleanup() {},
            };
          },
        },
        sendMessage: async () => {},
        registerGroup: async () => {},
        syncGroups: async () => {},
        getAvailableGroups: () => [],
        writeGroupsSnapshot: () => {},
        onSchedulerChanged: () => {},
        requestPermissionApproval: async () => {
          throw new Error('Unexpected permission prompt');
        },
        requestUserAnswer: async () => {
          throw new Error('Unexpected question');
        },
      };
    }, 60_000);

    afterAll(async () => {
      if (runtime) await runtime.cleanup();
      home?.cleanup();
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    async function delegate() {
      const requestId = randomUUID();
      const releasePath = path.join(home.runtimeHome, requestId);
      fs.writeFileSync(releasePath, 'waiting');
      register({
        sourceAgentFolder: 'main_agent',
        runHandle: requestId,
        policy: {
          appId: APP_ID,
          agentId: AGENT_ID,
          conversationId: CHAT,
          threadId: THREAD,
          protectedReadPaths: [],
          protectedWritePaths: [],
          allowedNetworkHosts: [],
          resourceLimits: { cpuSeconds: 0, memoryMb: 0, maxProcesses: 0 },
        },
      });
      const envelope = auth.createIpcAuthEnvelope('main_agent', THREAD, {
        appId: APP_ID,
        agentId: AGENT_ID,
      });
      const raw = {
        type: 'delegate_task',
        taskId: requestId,
        requestId,
        nonce: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        runHandle: requestId,
        chatJid: CHAT,
        context: {
          appId: APP_ID,
          agentId: AGENT_ID,
          threadId: THREAD,
          responseKeyId: envelope.responseKeyId,
        },
        payload: {
          objective: `Research and recommend\nrelease=${releasePath}`,
        },
      };
      await dispatch(
        parse(
          { ...raw, signature: sign(envelope.authToken, raw) },
          'main_agent',
        ),
        'main_agent',
        deps,
      );
      const response = JSON.parse(
        fs.readFileSync(
          path.join(
            home.runtimeHome,
            'data',
            'ipc',
            'main_agent',
            'task-responses',
            `task-${requestId}.json`,
          ),
          'utf8',
        ),
      );
      expect(response.ok, JSON.stringify(response)).toBe(true);
      const taskId: string = response.data.id;
      await vi.waitFor(
        () => expect(fs.existsSync(releasePath + '.ready')).toBe(true),
        { timeout: 10_000 },
      );
      fs.writeFileSync(releasePath, 'finish');
      await vi.waitFor(
        async () =>
          expect(
            (await runtime.repositories.asyncTasks.getTask(taskId))?.status,
          ).toBe('completed'),
        { timeout: 10_000 },
      );
      return taskId;
    }

    it('keeps the delegated child’s full streamed answer', async () => {
      const taskId = await delegate();
      expect(
        (await runtime.repositories.asyncTasks.getTask(taskId))?.outputSummary,
      ).toBe(ANSWER);
    }, 30_000);

    it('immediately wakes the chat parent with a durable delegated completion result', async () => {
      // A fixed claim clock keeps a slow machine from letting a quiet window expire.
      const claimNow = new Date().toISOString();
      const taskId = await delegate();
      const { AsyncCommandTaskService } =
        await import('@core/jobs/async-command-task-service.js');
      const recovery = new AsyncCommandTaskService(
        runtime.repositories.asyncTasks,
        { run: async () => ({}) },
        { completionMessageRepository: runtime.ops },
      );
      await recovery.recoverPendingDelegatedAgentFollowUps({ appId: APP_ID });
      const items =
        await runtime.repositories.liveTurns.claimLiveAdmissionWorkItems({
          appId: APP_ID,
          workerInstanceId: 'parent-worker',
          claimToken: randomUUID(),
          claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          limit: 100,
          now: claimNow,
        });
      const followUp = items.find(
        (item) => item.triggerDecision?.taskId === taskId,
      );
      expect(followUp).toMatchObject({
        agentId: AGENT_ID,
        conversationId: CHAT,
        threadId: THREAD,
      });
      const messages = await runtime.ops.getMessagesByIds(
        {
          appId: APP_ID,
          agentId: AGENT_ID,
          conversationId: CHAT,
          threadId: THREAD,
          providerAccountId: followUp!.providerAccountId,
        },
        [followUp!.messageId],
      );
      expect(messages[0]?.content).toContain(ANSWER);
      await recovery.recoverPendingDelegatedAgentFollowUps({ appId: APP_ID });
      expect(
        (await runtime.repositories.asyncTasks.getTask(taskId))?.receiptJson,
      ).toMatchObject({
        callableAgentFollowUp: { deliveredAt: expect.any(String) },
      });
    }, 30_000);
  },
);
