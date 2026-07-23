import fs from 'node:fs';
import { globSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { AgentE2EApiClient } from '../harness/api-client.js';
import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const hasDb = Boolean(process.env.GANTRY_TEST_DATABASE_URL?.trim());
const maybeDescribe = hasDb ? describe : describe.skip;
const TEST_TIMEOUT_MS = 300_000;

interface StoredJob {
  jobId: string;
  status: string;
  health: {
    state: string;
    latestRunId: string | null;
    latestRunStatus: string | null;
  };
}

interface JobEvent {
  event_type: string;
  payload: string | null;
}

function installRuntimeSettings(home: string): void {
  fs.writeFileSync(
    path.join(home, 'settings.yaml'),
    `runtime:
  deployment_mode: workstation
  sandbox:
    provider: sandbox_runtime

storage:
  postgres:
    url_env: GANTRY_DATABASE_URL
    schema: gantry
`,
  );
}

function installHermeticRunnerTools(home: string): string {
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  fs.writeFileSync(
    path.join(binDir, 'claude'),
    `#!${process.execPath}
const sessionId = '00000000-0000-4000-8000-000000000001';
let emitted = false;
let input = '';
function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function emit() {
  if (emitted) return;
  emitted = true;
  const messages = [
    {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'temporary',
      claude_code_version: 'agent-e2e-fake',
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [{ name: 'gantry', status: 'connected' }],
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: '00000000-0000-4000-8000-000000000002',
      session_id: sessionId,
    },
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000003',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: 'msg_agent_e2e_job_lifecycle',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'job completed' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: 'job completed',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: '00000000-0000-4000-8000-000000000004',
      session_id: sessionId,
    },
  ];
  for (const message of messages) write(message);
  setTimeout(() => process.exit(0), 50);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (
      message.type === 'control_request' &&
      message.request?.subtype === 'initialize'
    ) {
      write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: { commands: [], models: [], agents: [] },
        },
      });
      emit();
    } else if (
      message.type === 'control_request' &&
      message.request?.subtype === 'get_context_usage'
    ) {
      write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {
            categories: [],
            totalTokens: 2,
            maxTokens: 200000,
            rawMaxTokens: 200000,
            percentage: 0.001,
            gridRows: [],
            model: 'claude-haiku-4-5-20251001',
            memoryFiles: [],
            mcpTools: [],
            agents: [],
            isAutoCompactEnabled: false,
          },
        },
      });
      setTimeout(() => process.exit(0), 10);
    }
  }
});
process.stdin.on('end', emit);
`,
  );

  // The hermetic gate runs before CI installs bubblewrap/socat. These
  // per-scenario shims let the packaged sandbox wrapper start the isolated
  // deterministic runner without modifying the shared SDK executable. This
  // scenario proves jobs lifecycle behavior, not sandbox enforcement.
  fs.writeFileSync(
    path.join(binDir, 'socat'),
    `#!${process.execPath}
const fs = require('node:fs');
const listen = process.argv.find((arg) => arg.startsWith('UNIX-LISTEN:'));
const socketPath = listen?.slice('UNIX-LISTEN:'.length).split(',')[0];
if (socketPath) fs.closeSync(fs.openSync(socketPath, 'w'));
const finish = () => {
  if (socketPath) fs.rmSync(socketPath, { force: true });
  process.exit(0);
};
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
setInterval(() => {}, 60_000);
`,
  );
  fs.writeFileSync(
    path.join(binDir, 'rg'),
    `#!${process.execPath}
process.exit(0);
`,
  );
  fs.writeFileSync(
    path.join(binDir, 'bwrap'),
    `#!${process.execPath}
const { spawn } = require('node:child_process');
const marker = process.argv.indexOf('--');
if (marker < 0 || !process.argv[marker + 1]) {
  console.error('hermetic bwrap shim: command marker missing');
  process.exit(2);
}
const command = process.argv[marker + 1];
const args = process.argv.slice(marker + 2);
const last = args.length - 1;
if (last >= 0) {
  args[last] = args[last].replace(
    /[^\\s'"]*apply-seccomp[^\\s'"]*/g,
    '/usr/bin/env',
  );
}
const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, HOME: ${JSON.stringify(home)} },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
`,
  );
  for (const executable of ['claude', 'socat', 'rg', 'bwrap']) {
    fs.chmodSync(path.join(binDir, executable), 0o700);
  }
  return binDir;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'string'
    ? (JSON.parse(payload) as Record<string, unknown>)
    : ((payload ?? {}) as Record<string, unknown>);
}

maybeDescribe('agent-e2e job lifecycle (packaged runtime, hermetic)', () => {
  let harness: RuntimeHarness | undefined;
  let fakeHome = '';
  let failed = false;

  afterAll(async () => {
    if (failed && harness) {
      console.error(
        `[job-lifecycle] runtime log tail on failure:\n${harness.logs().slice(-12000)}`,
      );
      for (const agentLog of globSync(
        path.join(fakeHome, 'agents', '*', 'logs', '*.log'),
      )) {
        console.error(
          `[job-lifecycle] ${path.basename(agentLog)} tail:\n${fs.readFileSync(agentLog, 'utf8').slice(-12000)}`,
        );
      }
    }
    try {
      await harness?.teardown({ failed });
    } finally {
      if (fakeHome && !(failed && process.env.KEEP_EVIDENCE?.trim() === '1')) {
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it(
    'pauses, resumes, triggers, completes, delivers, and persists evidence',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      try {
        fakeHome = fs.mkdtempSync(
          path.join(os.tmpdir(), 'gantry-agent-e2e-job-home-'),
        );
        installRuntimeSettings(fakeHome);
        const runnerBin = installHermeticRunnerTools(fakeHome);
        harness = await startRuntimeHarness({
          mode: 'local-process',
          scopes: [
            'sessions:read',
            'sessions:write',
            'agents:admin',
            'credentials:admin',
            'jobs:read',
            'jobs:write',
          ],
          env: {
            GANTRY_HOME: fakeHome,
            HOME: fakeHome,
            PATH: `${runnerBin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
          },
        });
        const api = new AgentE2EApiClient(harness.baseUrl, harness.apiKey);

        const credential = await api.request<{ status: string }>(
          'PUT',
          '/v1/credentials/models/anthropic',
          {
            body: {
              authMode: 'api_key',
              payload: { apiKey: 'sk-ant-api03-agent-e2e-fake' },
            },
          },
        );
        expect(credential.status).toBe(200);
        expect(credential.body.status).toBe('active');

        const createdAgent = await api.request<{ id: string }>(
          'POST',
          '/v1/agents',
          {
            body: {
              appId: 'default',
              name: 'agent-e2e-job-lifecycle',
            },
          },
        );
        expect(createdAgent.status).toBe(201);
        const agentId = createdAgent.body.id;
        const workspaceKey = agentId.replace(/^agent:/, '');

        const ensured = await api.request<{
          sessionId: string;
          chatJid: string;
        }>('POST', '/v1/sessions/ensure', {
          body: {
            conversationId: 'job-lifecycle-e2e',
            agentId,
            title: 'job lifecycle e2e',
          },
        });
        expect(ensured.status).toBe(200);

        const createdJob = await api.request<{
          jobId: string;
          status: string;
        }>('POST', '/v1/jobs', {
          body: {
            name: 'agent-e2e job lifecycle',
            prompt: 'Complete this job successfully.',
            kind: 'manual',
            modelAlias: 'haiku',
            executionContext: {
              conversationJid: ensured.body.chatJid,
              threadId: null,
              workspaceKey,
              sessionId: ensured.body.sessionId,
            },
            notificationRoutes: [
              {
                conversationJid: ensured.body.chatJid,
                threadId: null,
                label: 'primary',
              },
            ],
          },
        });
        expect(createdJob.status).toBe(201);
        expect(createdJob.body.status).toBe('active');
        const jobId = createdJob.body.jobId;

        const paused = await api.request('POST', `/v1/jobs/${jobId}/pause`);
        expect(paused.status).toBe(200);
        const pausedJob = await api.request<StoredJob>(
          'GET',
          `/v1/jobs/${jobId}`,
        );
        expect(pausedJob.status).toBe(200);
        expect(pausedJob.body.status).toBe('paused');

        const rejectedTrigger = await api.request(
          'POST',
          `/v1/jobs/${jobId}/trigger`,
        );
        expect(rejectedTrigger.status).toBe(409);
        const pausedEvents = await api.request<{ events: JobEvent[] }>(
          'GET',
          `/v1/jobs/${jobId}/events`,
        );
        expect(pausedEvents.status).toBe(200);
        expect(
          pausedEvents.body.events.some(
            (event) => event.event_type === 'job.triggered',
          ),
        ).toBe(false);

        const resumed = await api.request<{ resumed: boolean }>(
          'POST',
          `/v1/jobs/${jobId}/resume`,
        );
        expect(resumed.status).toBe(200);
        expect(resumed.body.resumed).toBe(true);
        const activeJob = await api.request<StoredJob>(
          'GET',
          `/v1/jobs/${jobId}`,
        );
        expect(activeJob.status).toBe(200);
        expect(activeJob.body.status).toBe('active');

        const triggered = await api.request<{ triggerId: string }>(
          'POST',
          `/v1/jobs/${jobId}/trigger`,
        );
        expect(triggered.status).toBe(202);
        const triggerId = triggered.body.triggerId;
        const waited = await api.request<{
          runId: string;
          status: string;
        }>('GET', `/v1/triggers/${triggerId}/wait?timeoutMs=180000`);
        expect(waited.status).toBe(200);
        expect(waited.body.status, JSON.stringify(waited.body)).toBe(
          'completed',
        );
        const runId = waited.body.runId;

        type RunResponse = {
          run_id: string;
          job_id: string;
          status: string;
          ended_at: string | null;
          notified_at: string | null;
        };
        let run = await api.request<RunResponse>('GET', `/v1/runs/${runId}`);
        const deliveryDeadline = Date.now() + 15_000;
        while (run.body.notified_at === null && Date.now() < deliveryDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          run = await api.request<RunResponse>('GET', `/v1/runs/${runId}`);
        }
        expect(run.status).toBe(200);
        expect(run.body).toMatchObject({
          run_id: runId,
          job_id: jobId,
          status: 'completed',
          ended_at: expect.any(String),
          notified_at: expect.any(String),
        });

        const completedJob = await api.request<StoredJob>(
          'GET',
          `/v1/jobs/${jobId}`,
        );
        expect(completedJob.status).toBe(200);
        expect(completedJob.body.health).toMatchObject({
          state: 'completed',
          latestRunId: runId,
          latestRunStatus: 'completed',
        });

        const jobEvents = await api.request<{ events: JobEvent[] }>(
          'GET',
          `/v1/jobs/${jobId}/events`,
        );
        expect(jobEvents.status).toBe(200);
        const eventTypes = jobEvents.body.events.map(
          (event) => event.event_type,
        );
        expect(eventTypes).toEqual(
          expect.arrayContaining([
            'job.triggered',
            'job.run.started',
            'job.started',
            'job.completed',
            'job.run.completed',
          ]),
        );
        expect(
          payloadRecord(
            jobEvents.body.events.find(
              (event) => event.event_type === 'job.completed',
            )!.payload,
          ),
        ).toMatchObject({ delivery_state: 'sent', notified: true });

        const sessionEvents = await api.listEvents(ensured.body.sessionId);
        expect(
          sessionEvents.some(
            (event) => event.eventType === 'session.message.outbound',
          ),
        ).toBe(true);

        const client = new Client({ connectionString: harness.databaseUrl });
        await client.connect();
        try {
          const durableRun = await client.query(
            `SELECT id, job_id, status, ended_at, notified_at
               FROM gantry.agent_runs
              WHERE id = $1`,
            [runId],
          );
          expect(durableRun.rows).toEqual([
            expect.objectContaining({
              id: runId,
              job_id: jobId,
              status: 'completed',
              ended_at: expect.any(Date),
              notified_at: expect.any(Date),
            }),
          ]);

          const durableLease = await client.query(
            'SELECT status FROM gantry.run_leases WHERE run_id = $1',
            [runId],
          );
          expect(durableLease.rows).toEqual([{ status: 'completed' }]);

          const durableTrigger = await client.query(
            'SELECT status, run_id FROM gantry.job_triggers WHERE id = $1',
            [triggerId],
          );
          expect(durableTrigger.rows).toEqual([
            { status: 'completed', run_id: runId },
          ]);

          const durableEvents = await client.query<{
            event_type: string;
            payload_json: unknown;
          }>(
            `SELECT event_type, payload_json
               FROM gantry.runtime_events
              WHERE job_id = $1 OR (session_id = $2 AND event_type = 'session.message.outbound')
              ORDER BY event_id`,
            [jobId, ensured.body.sessionId],
          );
          expect(durableEvents.rows.map((event) => event.event_type)).toEqual(
            expect.arrayContaining([
              'job.triggered',
              'job.run.started',
              'job.started',
              'job.completed',
              'job.run.completed',
              'session.message.outbound',
            ]),
          );
          expect(
            payloadRecord(
              durableEvents.rows.find(
                (event) => event.event_type === 'job.completed',
              )!.payload_json,
            ),
          ).toMatchObject({ delivery_state: 'sent', notified: true });
        } finally {
          await client.end();
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  );
});
