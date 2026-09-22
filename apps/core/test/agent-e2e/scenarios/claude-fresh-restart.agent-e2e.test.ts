import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { AgentE2EApiClient } from '../harness/api-client.js';
import {
  startRuntimeHarness,
  type RuntimeHarness,
} from '../harness/runtime-harness.js';

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL?.trim()
  ? describe
  : describe.skip;
const TIMEOUT_MS = 300_000;

function installHermeticClaude(home: string): {
  binDir: string;
} {
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
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const executable = path.join(binDir, 'claude');
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
require('node:fs').appendFileSync(require('node:path').join(process.cwd(), 'claude-invoked'), 'invoked\\n');
const sessionId = '00000000-0000-4000-8000-000000000101';
let input = '';
let emitted = false;
const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
function emit() {
  if (emitted) return;
  emitted = true;
  write({
    type: 'system', subtype: 'init', apiKeySource: 'temporary',
    claude_code_version: 'agent-e2e-fake', cwd: process.cwd(), tools: [],
    mcp_servers: [{ name: 'gantry', status: 'connected' }],
    model: 'claude-haiku-4-5-20251001', permissionMode: 'default',
    slash_commands: [], output_style: 'default', skills: [], plugins: [],
    uuid: '00000000-0000-4000-8000-000000000102', session_id: sessionId,
  });
  write({
    type: 'assistant', uuid: '00000000-0000-4000-8000-000000000103',
    session_id: sessionId, parent_tool_use_id: null,
    message: {
      id: 'msg_claude_fresh_restart', type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'fresh restart complete' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  write({
    type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1,
    is_error: false, num_turns: 1, result: 'fresh restart complete',
    stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000104', session_id: sessionId,
  });
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
    if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
      write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], models: [], agents: [] } } });
    } else if (message.type === 'control_request' && message.request?.subtype === 'get_context_usage') {
      write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { categories: [], totalTokens: 2, maxTokens: 200000, rawMaxTokens: 200000, percentage: 0.001, gridRows: [], model: 'claude-haiku-4-5-20251001', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: false } } });
    } else if (message.type === 'user') {
      emit();
    }
  }
});
process.stdin.on('end', () => process.exit(emitted ? 0 : 2));
`,
  );
  const shell = path.join(binDir, 'bash');
  fs.writeFileSync(
    shell,
    `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn('/bin/bash', process.argv.slice(2), {
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
  for (const file of [executable, shell]) fs.chmodSync(file, 0o700);
  return { binDir };
}

maybeDescribe('Claude fresh restart', () => {
  let harness: RuntimeHarness | undefined;
  let runtimeHome = '';

  afterAll(async () => {
    try {
      await harness?.teardown();
    } finally {
      if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it(
    'restarts Claude without duplicate provider history',
    { timeout: TIMEOUT_MS },
    async () => {
      runtimeHome = fs.realpathSync(
        fs.mkdtempSync(
          path.join(os.tmpdir(), 'gantry-agent-e2e-claude-restart-'),
        ),
      );
      const hermeticClaude = installHermeticClaude(runtimeHome);
      harness = await startRuntimeHarness({
        mode: 'local-process',
        scopes: [
          'sessions:read',
          'sessions:write',
          'agents:admin',
          'credentials:admin',
        ],
        env: {
          GANTRY_HOME: runtimeHome,
          HOME: runtimeHome,
          PATH: `${hermeticClaude.binDir}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
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
      const agent = await api.request<{ id: string }>('POST', '/v1/agents', {
        body: { appId: 'default', name: 'claude-fresh-restart' },
      });
      expect(agent.status).toBe(201);
      const invocationMarker = path.join(
        runtimeHome,
        'agents',
        agent.body.id.replace(/^agent:/, ''),
        'claude-invoked',
      );
      const ensured = await api.request<{ sessionId: string }>(
        'POST',
        '/v1/sessions/ensure',
        {
          body: {
            conversationId: 'claude-fresh-restart',
            agentId: agent.body.id,
          },
        },
      );
      expect(ensured.status).toBe(200);
      const session = {
        sessionId: ensured.body.sessionId,
      };
      const client = new Client({ connectionString: harness.databaseUrl });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO gantry.provider_sessions
             (id, app_id, agent_session_id, provider, external_session_id,
              provider_ref_json, metadata_json, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, 'active')`,
          [
            'provider-session:stale-claude',
            'default',
            session.sessionId,
            'anthropic:claude-agent-sdk',
            'claude-sdk-handle',
            JSON.stringify({
              kind: 'provider_session',
              value: 'anthropic:claude-agent-sdk:claude-sdk-handle',
            }),
          ],
        );

        const before = await api.request<{ providerSession: unknown }>(
          'GET',
          `/v1/sessions/${encodeURIComponent(session.sessionId)}`,
        );
        expect(before.status).toBe(200);
        expect(before.body.providerSession).toBeNull();

        await harness.restart();
        const accepted = await api.postMessage(
          session.sessionId,
          'Confirm this is a fresh post-restart turn.',
        );
        expect(accepted.accepted).toBe(true);
        await expect
          .poll(() => fs.existsSync(invocationMarker), { timeout: 15_000 })
          .toBe(true);
        await api.waitForDurableAssistantReply(session.sessionId, {
          timeoutMs: TIMEOUT_MS - 60_000,
        });
        expect(fs.readFileSync(invocationMarker, 'utf8')).toBe('invoked\n');

        const after = await api.request<{ providerSession: unknown }>(
          'GET',
          `/v1/sessions/${encodeURIComponent(session.sessionId)}`,
        );
        expect(after.status).toBe(200);
        expect(after.body.providerSession).toBeNull();
        const rows = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count
             FROM gantry.provider_sessions
            WHERE agent_session_id = $1
              AND provider = 'anthropic:claude-agent-sdk'`,
          [session.sessionId],
        );
        expect(rows.rows[0]?.count).toBe(1);
        const runs = await client.query<{
          provider_run_id: string | null;
          provider_session_id: string | null;
        }>(
          `SELECT provider_run_id, provider_session_id
             FROM gantry.agent_runs
            WHERE app_id = 'default'
              AND agent_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [agent.body.id],
        );
        expect(runs.rows).toHaveLength(1);
        expect(runs.rows[0]).toEqual({
          provider_run_id: null,
          provider_session_id: null,
        });
      } finally {
        await client.end();
      }
    },
  );
});
