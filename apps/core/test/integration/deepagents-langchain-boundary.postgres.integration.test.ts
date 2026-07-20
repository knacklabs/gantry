import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { DeepAgentSessionStore } from '@core/adapters/llm/deepagents-langchain/runner/session-store.js';
import { ensureDeepAgentsCheckpointSchema } from '@core/adapters/llm/deepagents-langchain/checkpoint-setup.js';

// Spawns the real DeepAgents (LangChain) runner against a local fake model
// gateway that returns canned OpenAI chat-completions SSE. No real network: the
// runner only ever talks to the loopback fake gateway via the projected
// OPENAI_BASE_URL/OPENAI_API_KEY gateway env. Asserts the runner frame contract,
// env hygiene (only the run-scoped gateway token reaches upstream), and the
// adapter-private session persistence.

const RUNNER_ENTRY = path.resolve(
  __dirname,
  '../../src/adapters/llm/deepagents-langchain/runner/index.ts',
);
const TSX_BIN = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
const POSTGRES_TEST_DATABASE_URL = process.env.GANTRY_TEST_DATABASE_URL;
const maybeDescribe = POSTGRES_TEST_DATABASE_URL ? describe : describe.skip;
const checkpointPool = POSTGRES_TEST_DATABASE_URL
  ? new pg.Pool({ connectionString: POSTGRES_TEST_DATABASE_URL })
  : null;

// A self-contained stub Gantry facade MCP stdio server (plain Node, no TS) that
// the runner can spawn via `node <path>`. Exposes the baseline tools the runner
// projects so MultiServerMCPClient connects and the run can stream. When
// FORCE_TOOL is set it lets a forced tool_call be handled by the gantry tool.
function writeStubGantryMcpServer(filePath: string): void {
  const src = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'gantry', version: '0.0.0-test' });
const names = JSON.parse(process.env.GANTRY_MCP_TOOL_NAMES_JSON || '[]');
for (const name of names) {
  server.registerTool(
    name,
    { description: name + ' (stub)', inputSchema: { text: z.string().optional() } },
    async () => ({ content: [{ type: 'text', text: name + ' ok' }] }),
  );
}
const transport = new StdioServerTransport();
await server.connect(transport);
`;
  fs.writeFileSync(filePath, src);
}

interface ParsedFrame {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  sessionInit?: boolean;
  continuedByFollowup?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    model?: string;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalBillableInputTokens?: number;
    cacheProvider?: string;
    cacheStatus?: string;
  };
  contextUsage?: {
    maxTokens: number;
    totalTokens: number;
    apiUsage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    } | null;
  };
  runtimeEvents?: Array<{
    eventType?: string;
    payload?: Record<string, unknown>;
  }>;
  error?: string;
}

// A frame is a "turn-complete marker" iff the host's isAgentTurnCompleteMarker
// would treat it as one: success, no result text, not a session-init frame, and
// not a continuation frame. (compactBoundary/interactionBoundary are never
// emitted by this lane.) Used to assert exactly one terminal marker per turn.
function isTurnCompleteMarker(frame: ParsedFrame): boolean {
  return (
    frame.status === 'success' &&
    !frame.result &&
    !frame.sessionInit &&
    !frame.continuedByFollowup
  );
}

function parseFrames(stdout: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  const re = /---GANTRY_OUTPUT_START---\n([\s\S]*?)\n---GANTRY_OUTPUT_END---/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stdout)) !== null) {
    frames.push(JSON.parse(match[1].trim()) as ParsedFrame);
  }
  return frames;
}

function messageContentText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

interface FakeGateway {
  baseUrl: string;
  requests: Array<{ authorization?: string; body: string; path: string }>;
  close: () => Promise<void>;
}

async function startFakeOpenAiGateway(): Promise<FakeGateway> {
  const requests: FakeGateway['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        authorization: req.headers.authorization,
        body,
        path: req.url ?? '',
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = 'chatcmpl-integration';
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Hello' },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { content: ' Gantry' }, finish_reason: null },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 42, completion_tokens: 5, total_tokens: 47 },
        },
      ];
      for (const chunk of chunks) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'gpt-5.5', ...chunk })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake gateway did not bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/openai`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

// A gateway that forces ONE named tool call (with JSON arguments) on the first
// turn, then a plain text answer once the tool result is seen. Used to drive the
// Gantry shell tool (RunCommand) gate end to end.
async function startNamedToolForcingGateway(
  toolName: string,
  toolArguments: string,
): Promise<FakeGateway> {
  const requests: FakeGateway['requests'] = [];
  let turn = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        authorization: req.headers.authorization,
        body,
        path: req.url ?? '',
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = 'chatcmpl-named-tool';
      const firstTurn = turn === 0;
      turn += 1;
      const chunks = firstTurn
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_shell',
                        type: 'function',
                        function: { name: toolName, arguments: toolArguments },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            },
          ]
        : [
            {
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'Done.' },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 2,
                total_tokens: 22,
              },
            },
          ];
      for (const chunk of chunks) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'gpt-5.5', ...chunk })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('named-tool gateway did not bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/openai`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

// A fake OPENROUTER chat-completions gateway: OpenRouter is OpenAI-wire-
// compatible, so this serves OpenAI-shaped SSE that ChatOpenRouter parses, with
// a FINAL usage chunk carrying prompt_tokens_details.{cached_tokens,
// cache_write_tokens} (prompt-cache reads/writes). Used to prove end-to-end
// OpenRouter cache accounting and session_id forwarding through the loopback
// gateway, with NO real network. The gateway base path is /openrouter so
// ChatOpenRouter (baseURL .../openrouter/v1) posts to /openrouter/v1/chat/
// completions.
async function startFakeOpenRouterGateway(): Promise<FakeGateway> {
  const requests: FakeGateway['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        authorization: req.headers.authorization,
        body,
        path: req.url ?? '',
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = 'chatcmpl-openrouter';
      const model = 'moonshotai/kimi-k2.6';
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Hello' },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { content: ' Gantry' }, finish_reason: null },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          // Prompt-cache reads (cached_tokens) and writes (cache_write_tokens)
          // on the final usage chunk — the OpenRouter prefix-cache shape.
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 12,
            total_tokens: 1012,
            prompt_tokens_details: {
              cached_tokens: 800,
              cache_write_tokens: 150,
            },
          },
        },
      ];
      for (const chunk of chunks) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, ...chunk })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake openrouter gateway did not bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/openrouter`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

// An OpenAI-format gateway that holds the response open for `delayMs` before
// streaming, so a `_close` sentinel written shortly after spawn lands while the
// turn is in flight (the live-control poll loop then aborts the stream). Used to
// prove close-stdin terminates the lane without a completed marker (R9).
async function startSlowOpenAiGateway(delayMs: number): Promise<FakeGateway> {
  const requests: FakeGateway['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        authorization: req.headers.authorization,
        body,
        path: req.url ?? '',
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = 'chatcmpl-slow';
      // First a small delta, then a long pause before the rest. The pause is the
      // window the in-flight `_close` abort fires in.
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'gpt-5.5', choices: [{ index: 0, delta: { role: 'assistant', content: 'Working' }, finish_reason: null }] })}\n\n`,
      );
      setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'gpt-5.5', choices: [{ index: 0, delta: { content: ' done' }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'gpt-5.5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('slow gateway did not bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/openai`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function startContinuationGateway(input: {
  firstDelayMs: number;
  onFirstRequest: () => void;
}): Promise<FakeGateway> {
  const requests: FakeGateway['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const requestIndex = requests.length;
      requests.push({
        authorization: req.headers.authorization,
        body,
        path: req.url ?? '',
      });
      if (requestIndex === 0) input.onFirstRequest();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = `chatcmpl-continuation-${requestIndex + 1}`;
      const content = requestIndex === 0 ? 'First answer' : 'Follow-up answer';
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'gpt-5.5', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`,
      );
      const finish = () => {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'gpt-5.5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7 + requestIndex, completion_tokens: 2, total_tokens: 9 + requestIndex } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (requestIndex === 0) {
        setTimeout(finish, input.firstDelayMs);
      } else {
        finish();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('continuation gateway did not bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/openai`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

interface TempRoot {
  root: string;
  sessionsDir: string;
  checkpointSchema: string;
  inputDir: string;
  ipcDir: string;
  workspaceIpcDir: string;
  gantryServerPath: string;
  mcpConfigPath: string;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function runRunner(input: {
  stdin: Record<string, unknown>;
  temp: TempRoot;
  baseUrl: string;
  apiKey: string;
  deepAgentCheckpointerOverride?: {
    databaseUrl: string;
    schema: string;
  };
  // The resolved model provider the host projects to the runner; it selects the
  // LangChain class (openai -> ChatOpenAI via initChatModel; openrouter ->
  // ChatOpenRouter). Defaults to the openai lane.
  provider?: 'openai' | 'openrouter';
  modelId?: string;
  // Gated cache_control mode the host derives from the model's cache descriptor.
  cachePromptControl?: 'automatic' | 'explicit' | 'none';
  extraEnv?: Record<string, string>;
  // Invoked with the spawned child so a test can drive the IPC dir (e.g. write a
  // _close sentinel) while the run is in flight, then close stdin.
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (!input.stdin.isScheduledJob) {
    await ensureDeepAgentsCheckpointSchema({
      databaseUrl: POSTGRES_TEST_DATABASE_URL ?? '',
      schema: input.temp.checkpointSchema,
    });
  }
  const provider = input.provider ?? 'openai';
  const modelId =
    input.modelId ??
    (provider === 'openrouter' ? 'moonshotai/kimi-k2.6' : 'gpt-5.5');
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [RUNNER_ENTRY], {
      env: {
        ...process.env,
        GANTRY_DEEPAGENTS_MODEL_ID: modelId,
        // The runner builds the LangChain model from the projected provider
        // string (host execution-adapter projects modelRoute.id). Without it the
        // runner fails closed before any upstream call.
        GANTRY_DEEPAGENTS_MODEL_PROVIDER: provider,
        GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL:
          input.cachePromptControl ?? 'automatic',
        GANTRY_IPC_INPUT_DIR: input.temp.inputDir,
        // Common host env (agent-spawn projects these for every runner). The
        // runner spawns the Gantry facade MCP stdio server with this path and
        // wires its IPC env block.
        GANTRY_MCP_SERVER_PATH: input.temp.gantryServerPath,
        GANTRY_IPC_DIR: input.temp.ipcDir,
        GANTRY_IPC_AUTH_TOKEN: 'ipc-auth',
        GANTRY_IPC_RESPONSE_VERIFY_KEY: '',
        GANTRY_IPC_RESPONSE_KEY_ID: 'key-id',
        GANTRY_APP_ID: 'default',
        GANTRY_AGENT_ID: 'agent:main_agent',
        GANTRY_CHAT_JID: String(input.stdin.chatJid ?? 'tg:group'),
        GANTRY_WORKSPACE_KEY: String(input.stdin.workspaceFolder ?? 'group'),
        GANTRY_MEMORY_DEFAULT_SCOPE: 'group',
        GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: '1500',
        GANTRY_PERMISSION_TIMEOUT_MS: '1500',
        ...input.extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    // Both DeepAgents lanes (openai + openrouter) project the OpenAI-family
    // gateway env (single loopback base-url + run-scoped gtw_ token); the
    // provider string selects the LangChain class, not which env var is set.
    const modelCredentialEnv = {
      OPENAI_BASE_URL: input.baseUrl,
      OPENAI_API_KEY: input.apiKey,
    };
    const deepAgentCheckpointer = input.stdin.isScheduledJob
      ? undefined
      : (input.deepAgentCheckpointerOverride ?? {
          databaseUrl: POSTGRES_TEST_DATABASE_URL,
          schema: input.temp.checkpointSchema,
        });
    child.stdin.write(
      JSON.stringify({
        ...input.stdin,
        ...(deepAgentCheckpointer ? { deepAgentCheckpointer } : {}),
        modelCredentialEnv,
      }),
    );
    child.stdin.end();
    input.onSpawn?.(child);
  });
}

const tempRoots: string[] = [];
const checkpointSchemas: string[] = [];
let checkpointCounter = 0;
// Stub MCP servers must resolve @modelcontextprotocol/sdk from the repo
// node_modules, so the temp tree lives under the repo (not os.tmpdir()).
const REPO_TMP_BASE = path.resolve(__dirname, '../.tmp-deepagents-int');

function makeTempRoot(): TempRoot {
  fs.mkdirSync(REPO_TMP_BASE, { recursive: true });
  const root = fs.mkdtempSync(path.join(REPO_TMP_BASE, 'run-'));
  tempRoots.push(root);
  const checkpointSchema = `gda_boundary_${process.pid}_${++checkpointCounter}`;
  checkpointSchemas.push(checkpointSchema);
  const sessionsDir = path.join(root, 'sessions');
  const inputDir = path.join(root, 'ipc-input');
  const ipcDir = path.join(root, 'ipc');
  const workspaceFolder = 'group';
  const workspaceIpcDir = path.join(ipcDir, workspaceFolder);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(workspaceIpcDir, { recursive: true });
  const gantryServerPath = path.join(root, 'gantry-mcp.mjs');
  const mcpConfigPath = path.join(root, 'mcp-config.json');
  writeStubGantryMcpServer(gantryServerPath);
  return {
    root,
    sessionsDir,
    checkpointSchema,
    inputDir,
    ipcDir,
    workspaceIpcDir,
    gantryServerPath,
    mcpConfigPath,
  };
}

async function expectCheckpointExists(
  temp: TempRoot,
  sessionId: string,
): Promise<void> {
  const store = new DeepAgentSessionStore({
    databaseUrl: POSTGRES_TEST_DATABASE_URL ?? '',
    schema: temp.checkpointSchema,
  });
  const saver = await store.load(sessionId);
  const tuple = await saver.getTuple({
    configurable: { thread_id: sessionId },
  });
  await saver.end();
  expect(tuple).toBeTruthy();
}

async function putCheckpoint(input: {
  temp: TempRoot;
  sessionId: string;
  content: string;
}): Promise<void> {
  await ensureDeepAgentsCheckpointSchema({
    databaseUrl: POSTGRES_TEST_DATABASE_URL ?? '',
    schema: input.temp.checkpointSchema,
  });
  const store = new DeepAgentSessionStore({
    databaseUrl: POSTGRES_TEST_DATABASE_URL ?? '',
    schema: input.temp.checkpointSchema,
  });
  const saver = await store.create(input.sessionId);
  await saver.put(
    { configurable: { thread_id: input.sessionId } },
    {
      v: 4,
      ts: new Date(0).toISOString(),
      id: `checkpoint-${input.sessionId}`,
      channel_values: {
        messages: [{ role: 'human', content: input.content }],
      },
      channel_versions: { messages: 1 },
      versions_seen: {},
      pending_sends: [],
    },
    {},
    { messages: 1 },
  );
  await saver.end();
}

async function corruptCheckpointBlob(input: {
  temp: TempRoot;
  sessionId: string;
}): Promise<void> {
  const result = await checkpointPool?.query(
    `UPDATE ${quoteIdent(input.temp.checkpointSchema)}.checkpoint_blobs
     SET type = 'json', blob = $2
     WHERE thread_id = $1`,
    [input.sessionId, Buffer.from('{')],
  );
  expect(result?.rowCount).toBeGreaterThan(0);
}

function unauthorizedDatabaseUrl(): string {
  const url = new URL(POSTGRES_TEST_DATABASE_URL ?? '');
  url.username = `gantry_forbidden_${process.pid}`;
  url.password = 'bad-password';
  return url.toString();
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.rmSync(REPO_TMP_BASE, { recursive: true, force: true });
  for (const schema of checkpointSchemas.splice(0)) {
    await checkpointPool?.query(
      `DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`,
    );
  }
});

afterAll(async () => {
  await checkpointPool?.end();
});

maybeDescribe('DeepAgents (LangChain) runner boundary integration', () => {
  it('streams runner frames from a gateway-backed OpenAI run and persists the session', async () => {
    const gateway = await startFakeOpenAiGateway();
    const temp = makeTempRoot();
    const sessionsDir = temp.sessionsDir;
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'say hello',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          memoryContextBlock:
            '<gantry_memory_context trust="untrusted_data_only">initial memory</gantry_memory_context>',
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });

      expect(result.code).toBe(0);
      const frames = parseFrames(result.stdout);

      // R1: the first frame carries the session id immediately for durable
      // persistence and is flagged sessionInit, so the host does NOT treat it as
      // turn completion (which would idle + dequeue at turn START).
      expect(frames[0]).toMatchObject({
        status: 'success',
        result: null,
        sessionInit: true,
      });
      expect(isTurnCompleteMarker(frames[0])).toBe(false);
      const sessionId = frames[0].newSessionId;
      expect(sessionId).toBeTruthy();
      expect(frames.every((frame) => frame.newSessionId === sessionId)).toBe(
        true,
      );

      // R2: exactly ONE turn-complete marker for a single-turn run, and it is
      // the last frame.
      const markerIdxs = frames
        .map((frame, idx) => (isTurnCompleteMarker(frame) ? idx : -1))
        .filter((idx) => idx >= 0);
      expect(markerIdxs).toEqual([frames.length - 1]);

      // Text deltas stream through, then a final usage/context frame.
      const textDeltas = frames
        .map((frame) => frame.result)
        .filter((value): value is string => typeof value === 'string');
      expect(textDeltas.join('')).toBe('Hello Gantry');

      const usageFrame = frames.find((frame) => frame.usage);
      expect(usageFrame?.usage).toMatchObject({
        model: 'gpt-5.5',
        inputTokens: 42,
        outputTokens: 5,
      });
      // Context window is reported at runtime from the LangChain model profile,
      // not from the catalog (deepagents entries omit contextWindowTokens).
      expect(usageFrame?.contextUsage?.maxTokens).toBeGreaterThan(0);

      // Env hygiene: only the run-scoped gateway token reaches the upstream.
      expect(gateway.requests.length).toBeGreaterThan(0);
      expect(
        gateway.requests.some((request) =>
          request.body.includes('initial memory'),
        ),
      ).toBe(true);
      // The OpenAI SDK appends /chat/completions to the projected gateway
      // baseUrl (.../openai); the real Gantry gateway maps that to
      // api.openai.com/v1/chat/completions (proven in the gateway unit test).
      for (const request of gateway.requests) {
        expect(request.authorization).toBe('Bearer gtw_integrationtoken');
        expect(request.path).toContain('/openai/chat/completions');
        expect(request.body).not.toContain('gtw_');
      }

      // Adapter-private LangGraph checkpoint projection is persisted through
      // the official PostgresSaver. There is no JSON session-file fallback.
      expect(fs.readdirSync(sessionsDir)).toEqual([]);
      await expectCheckpointExists(temp, sessionId as string);
      const startupDiagnostic = frames
        .flatMap((frame) => frame.runtimeEvents ?? [])
        .find((event) => event.eventType === 'run.startup_diagnostic');
      expect(startupDiagnostic?.payload).toMatchObject({
        checkpointerConfigured: true,
        checkpointLoadCount: expect.any(Number),
        checkpointLoadMs: expect.any(Number),
        checkpointWriteCount: expect.any(Number),
        checkpointWriteMs: expect.any(Number),
      });
      expect(
        (startupDiagnostic?.payload?.checkpointWriteCount as number) ?? 0,
      ).toBeGreaterThan(0);

      const resumed = await runRunner({
        stdin: {
          prompt: 'resume the same checkpoint',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          sessionId,
          memoryContextBlock:
            '<gantry_memory_context trust="untrusted_data_only">fresh resumed memory</gantry_memory_context>',
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });
      expect(resumed.code).toBe(0);
      const resumedFrames = parseFrames(resumed.stdout);
      const resumedStartupDiagnostic = resumedFrames
        .flatMap((frame) => frame.runtimeEvents ?? [])
        .find((event) => event.eventType === 'run.startup_diagnostic');
      expect(resumedStartupDiagnostic?.payload).toMatchObject({
        checkpointerConfigured: true,
        checkpointLoadCount: expect.any(Number),
        checkpointLoadMs: expect.any(Number),
        checkpointWriteCount: expect.any(Number),
        checkpointWriteMs: expect.any(Number),
      });
      expect(
        (resumedStartupDiagnostic?.payload?.checkpointLoadCount as number) ?? 0,
      ).toBeGreaterThan(0);
      expect(
        (resumedStartupDiagnostic?.payload?.checkpointWriteCount as number) ??
          0,
      ).toBeGreaterThan(0);
      expect(
        gateway.requests.some((request) =>
          request.body.includes('fresh resumed memory'),
        ),
      ).toBe(true);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  it('sends only buffered follow-up text as the prompt for continuation turns', async () => {
    const temp = makeTempRoot();
    const initialPrompt = 'initial unique prompt alpha';
    const followup = 'follow-up unique prompt beta';
    const gateway = await startContinuationGateway({
      firstDelayMs: 750,
      onFirstRequest: () => {
        fs.writeFileSync(
          path.join(temp.inputDir, '001-followup.json'),
          JSON.stringify({ type: 'message', text: followup }),
        );
      },
    });
    try {
      const result = await runRunner({
        stdin: {
          prompt: initialPrompt,
          workspaceFolder: 'group',
          chatJid: 'tg:group',
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });

      expect(result.code).toBe(0);
      expect(gateway.requests.length).toBeGreaterThanOrEqual(2);
      const frames = parseFrames(result.stdout);
      expect(frames.some((frame) => frame.continuedByFollowup)).toBe(true);

      const secondBody = JSON.parse(gateway.requests[1].body) as {
        messages?: unknown;
      };
      const serializedMessages = JSON.stringify(secondBody.messages);
      const initialOccurrences =
        serializedMessages.split(initialPrompt).length - 1;
      const followupOccurrences = serializedMessages.split(followup).length - 1;
      expect(initialOccurrences).toBe(1);
      expect(followupOccurrences).toBe(1);
      const messages = Array.isArray(secondBody.messages)
        ? secondBody.messages
        : [];
      const lastUserMessage = messages
        .filter(
          (message): message is { role?: unknown; content?: unknown } =>
            Boolean(message) &&
            typeof message === 'object' &&
            (message as { role?: unknown }).role === 'user',
        )
        .at(-1);
      const lastUserContent = messageContentText(lastUserMessage);
      expect(lastUserContent).toContain(followup);
      expect(lastUserContent).not.toContain(initialPrompt);
      const sessionId = frames[0].newSessionId;
      expect(sessionId).toBeTruthy();
      if (!sessionId) throw new Error('missing session id');
      expect(fs.readdirSync(temp.sessionsDir)).toEqual([]);
      await expectCheckpointExists(temp, sessionId);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  it('throws a stale-session error when resuming an unknown session id', async () => {
    const gateway = await startFakeOpenAiGateway();
    const temp = makeTempRoot();
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'resume please',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          sessionId: 'missing-session-id',
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });

      expect(result.code).toBe(1);
      const frames = parseFrames(result.stdout);
      const errorFrame = frames.find((frame) => frame.status === 'error');
      expect(errorFrame?.error).toContain(
        'No DeepAgents session found with session ID',
      );
      // No upstream call should happen for a missing session.
      expect(gateway.requests.length).toBe(0);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  it('does not resume from a checkpoint owned by a different thread id', async () => {
    const gateway = await startFakeOpenAiGateway();
    const temp = makeTempRoot();
    const otherSessionId = 'other-session-id';
    const requestedSessionId = 'requested-session-id';
    try {
      await putCheckpoint({
        temp,
        sessionId: otherSessionId,
        content: 'checkpoint belongs to another thread',
      });

      const result = await runRunner({
        stdin: {
          prompt: 'resume the requested session',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          sessionId: requestedSessionId,
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });

      expect(result.code).toBe(1);
      const frames = parseFrames(result.stdout);
      const errorFrame = frames.find((frame) => frame.status === 'error');
      expect(errorFrame?.error).toContain(
        `No DeepAgents session found with session ID: ${requestedSessionId}`,
      );
      expect(errorFrame?.error).not.toContain(otherSessionId);
      expect(frames.some((frame) => frame.sessionInit)).toBe(false);
      expect(gateway.requests.length).toBe(0);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  it('fails before session init and model startup when checkpoint data is corrupt', async () => {
    const gateway = await startFakeOpenAiGateway();
    const temp = makeTempRoot();
    const sessionId = 'corrupt-session-id';
    try {
      await putCheckpoint({
        temp,
        sessionId,
        content: 'this checkpoint will be corrupted',
      });
      await corruptCheckpointBlob({ temp, sessionId });

      const result = await runRunner({
        stdin: {
          prompt: 'resume corrupt session',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          sessionId,
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });

      expect(result.code).toBe(1);
      const frames = parseFrames(result.stdout);
      const errorFrame = frames.find((frame) => frame.status === 'error');
      expect(errorFrame?.error).toMatch(
        /Unexpected end of JSON input|Unexpected token|Expected property name/i,
      );
      expect(frames.some((frame) => frame.sessionInit)).toBe(false);
      expect(gateway.requests.length).toBe(0);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  it('fails before session init and model startup when the checkpoint store is unauthorized', async () => {
    const gateway = await startFakeOpenAiGateway();
    const temp = makeTempRoot();
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'resume unauthorized checkpoint store',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          sessionId: 'unauthorized-session-id',
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
        deepAgentCheckpointerOverride: {
          databaseUrl: unauthorizedDatabaseUrl(),
          schema: temp.checkpointSchema,
        },
      });

      expect(result.code).toBe(1);
      const frames = parseFrames(result.stdout);
      const errorFrame = frames.find((frame) => frame.status === 'error');
      expect(errorFrame?.error).toMatch(
        /authentication failed|password authentication failed|role .* does not exist|permission denied|SASL/i,
      );
      expect(frames.some((frame) => frame.sessionInit)).toBe(false);
      expect(gateway.requests.length).toBe(0);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  it('runs an ephemeral scheduled job without persisting a session file', async () => {
    const gateway = await startFakeOpenAiGateway();
    const temp = makeTempRoot();
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'do the job',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          isScheduledJob: true,
          jobId: 'job-1',
          runId: 'run-1',
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });

      expect(result.code).toBe(0);
      const frames = parseFrames(result.stdout);
      expect(frames.some((frame) => frame.usage)).toBe(true);
      // Scheduled jobs are ephemeral: no session file is written.
      expect(fs.readdirSync(temp.sessionsDir)).toEqual([]);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  it('rejects direct third-party MCP config before model calls or permission requests', async () => {
    const gateway = await startFakeOpenAiGateway();
    const temp = makeTempRoot();
    fs.writeFileSync(
      temp.mcpConfigPath,
      JSON.stringify({
        notion: {
          command: process.execPath,
          args: ['third-party-mcp-should-not-spawn.mjs'],
        },
      }),
    );
    const requestDir = path.join(temp.workspaceIpcDir, 'permission-requests');
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'search notion for the roadmap',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          allowedTools: ['mcp__notion__search'],
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
        extraEnv: {
          GANTRY_MCP_CONFIG_FILE: temp.mcpConfigPath,
        },
      });

      expect(result.code).toBe(1);
      const frames = parseFrames(result.stdout);
      expect(frames[0]).toMatchObject({
        status: 'success',
        result: null,
        sessionInit: true,
      });
      const errorFrame = frames.find((frame) => frame.status === 'error');
      expect(errorFrame?.error).toMatch(
        /direct third-party MCP config is disabled.*notion.*stdio.*DNS-pinned MCP dispatcher/,
      );
      expect(gateway.requests.length).toBe(0);
      const requestFiles = fs.existsSync(requestDir)
        ? fs.readdirSync(requestDir).filter((file) => file.endsWith('.json'))
        : [];
      expect(requestFiles).toEqual([]);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  // OpenRouter cache accounting end to end: a fake OpenRouter chat-completions
  // gateway returns a streamed FINAL chunk carrying usage with
  // prompt_tokens_details.{cached_tokens,cache_write_tokens}. Asserts the
  // runner's output frame carries the accounted cacheReadTokens/cacheWriteTokens
  // and that the durable session_id was forwarded in the request body for sticky
  // cache routing — with no gateway-token leakage to the upstream body.
  it('accounts OpenRouter prompt-cache reads/writes and forwards session_id', async () => {
    const gateway = await startFakeOpenRouterGateway();
    const temp = makeTempRoot();
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'say hello',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
        },
        temp,
        provider: 'openrouter',
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_openroutertoken',
      });

      expect(result.code).toBe(0);
      const frames = parseFrames(result.stdout);
      const sessionId = frames[0].newSessionId;
      expect(sessionId).toBeTruthy();

      const usageFrame = frames.find((frame) => frame.usage);
      expect(usageFrame?.usage).toMatchObject({
        model: 'moonshotai/kimi-k2.6',
        inputTokens: 1000,
        outputTokens: 12,
        cacheReadTokens: 800,
        cacheWriteTokens: 150,
        // billable input = input - reads.
        totalBillableInputTokens: 200,
        cacheProvider: 'openrouter-provider',
        cacheStatus: 'partial',
      });
      expect(usageFrame?.contextUsage?.apiUsage).toMatchObject({
        cache_creation_input_tokens: 150,
        cache_read_input_tokens: 800,
      });

      // The durable session id was forwarded as body `session_id` on EVERY
      // upstream request (sticky routing), and it equals the runner's session id.
      expect(gateway.requests.length).toBeGreaterThan(0);
      for (const request of gateway.requests) {
        expect(request.authorization).toBe('Bearer gtw_openroutertoken');
        // ChatOpenRouter posts to <baseURL>/chat/completions; baseURL carries
        // the /v1 segment -> loopback /openrouter/v1/chat/completions.
        expect(request.path).toContain('/openrouter/v1/chat/completions');
        // No gateway token leaks into the request body.
        expect(request.body).not.toContain('gtw_');
        const parsed = JSON.parse(request.body) as { session_id?: string };
        expect(parsed.session_id).toBe(sessionId);
      }
    } finally {
      await gateway.close();
    }
  }, 120_000);

  // R9: an in-flight run that receives a `_close` sentinel (close-stdin / STOP)
  // aborts the stream and exits cleanly WITHOUT emitting a turn-complete marker
  // (mirrors the Anthropic lane returning on closedDuringQuery with no final
  // frame). The host settles the turn on process exit.
  it('aborts an in-flight run on a _close sentinel and exits cleanly with NO completed marker (close-stdin)', async () => {
    // Hold the response open long enough for the live-control poll loop to see
    // the close sentinel we write while the turn is in flight. The gateway
    // streams one delta immediately, then pauses for the rest — the pause is the
    // window the abort fires in.
    const gateway = await startSlowOpenAiGateway(8_000);
    const temp = makeTempRoot();
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'long running please',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
        onSpawn: (child) => {
          // The runner clears any pre-existing _close at startup
          // (prepareInteractiveIpcInputDir). tsx cold start can be multiple
          // seconds, so a fixed delay races prepare. Instead, write the sentinel
          // only AFTER the runner emits its first stdout frame (the sessionInit
          // frame), which is emitted after prepare ran and the run is under way
          // — guaranteeing the sentinel survives and lands while the 8s gateway
          // pause keeps the turn in flight.
          let closeWritten = false;
          child.stdout?.on('data', (chunk: Buffer) => {
            if (closeWritten) return;
            if (chunk.toString().includes('GANTRY_OUTPUT_START')) {
              closeWritten = true;
              fs.writeFileSync(path.join(temp.inputDir, '_close'), '');
            }
          });
        },
      });

      // Clean exit (graceful stop, not a crash).
      expect(result.code).toBe(0);
      const frames = parseFrames(result.stdout);
      // The session-init frame is emitted up front...
      expect(frames[0]).toMatchObject({ sessionInit: true });
      // ...but NO turn-complete marker is emitted on a close-driven termination.
      expect(frames.some((frame) => isTurnCompleteMarker(frame))).toBe(false);
      // No error frame either (graceful stop).
      expect(frames.some((frame) => frame.status === 'error')).toBe(false);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  // Phase 4: under GANTRY_DEEPAGENTS_SHELL_ENABLED='1' + a RunCommand rule, the
  // model sees a gated `RunCommand` shell tool. A command that the scoped rule
  // allows runs without a permission prompt (policy match), executes inside the
  // runner process, and the run completes — proving the tool is projected and
  // gated, and the command actually executed.
  it('projects a gated RunCommand shell tool under sandbox-enabled flag + RunCommand rule and runs an allowed command', async () => {
    const gateway = await startNamedToolForcingGateway(
      'RunCommand',
      JSON.stringify({ command: 'echo gantry-shell-ran' }),
    );
    const temp = makeTempRoot();
    const requestDir = path.join(temp.workspaceIpcDir, 'permission-requests');
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'run the command',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          // The scoped rule allows `echo *`, so the gate ALLOWS without a prompt.
          allowedTools: ['RunCommand(echo *)'],
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
        extraEnv: {
          // Host projects this only on the allowed path (deepagents + RunCommand
          // rule + sandbox_runtime). Setting it here simulates that projection.
          GANTRY_DEEPAGENTS_SHELL_ENABLED: '1',
        },
      });

      expect(result.code).toBe(0);
      // No permission-request file: the scoped rule allowed the command, so the
      // gate did not need to prompt the host.
      const requestFiles = fs.existsSync(requestDir)
        ? fs.readdirSync(requestDir).filter((file) => file.endsWith('.json'))
        : [];
      expect(requestFiles.length).toBe(0);
      // The second upstream turn carries the tool result back to the model; the
      // executed command's stdout is in the request body.
      expect(gateway.requests.length).toBeGreaterThanOrEqual(2);
      const secondBody = gateway.requests[1]?.body ?? '';
      expect(secondBody).toContain('gantry-shell-ran');
      expect(secondBody).toContain('exited with code 0');
      const frames = parseFrames(result.stdout);
      expect(frames.some((frame) => frame.status === 'error')).toBe(false);
    } finally {
      await gateway.close();
    }
  }, 120_000);

  // Phase 4 negative: WITHOUT the host flag the RunCommand shell tool is NOT
  // projected even when a RunCommand rule is present — behavior is exactly as
  // before (no shell execution surface). The forced tool call then fails to bind
  // and the run surfaces an error frame, proving the tool was absent.
  it('does NOT project the shell tool without the host flag (no shell surface)', async () => {
    const gateway = await startNamedToolForcingGateway(
      'RunCommand',
      JSON.stringify({ command: 'echo should-not-exist' }),
    );
    const temp = makeTempRoot();
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'run the command',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          allowedTools: ['RunCommand(echo *)'],
        },
        temp,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
        // GANTRY_DEEPAGENTS_SHELL_ENABLED is intentionally NOT set.
      });

      // The model tried to call a tool that was never bound; the lane fails the
      // turn (no silent execution surface). The key invariant: the command never
      // ran, so no executed-output marker reaches the gateway.
      const ranOutput = gateway.requests.some((request) =>
        request.body.includes('exited with code'),
      );
      expect(ranOutput).toBe(false);
    } finally {
      await gateway.close();
    }
  }, 120_000);
});
