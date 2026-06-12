import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

interface ParsedFrame {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  usage?: { inputTokens: number; outputTokens: number; model?: string };
  contextUsage?: { maxTokens: number; totalTokens: number };
  error?: string;
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

function runRunner(input: {
  stdin: Record<string, unknown>;
  sessionsDir: string;
  inputDir: string;
  baseUrl: string;
  apiKey: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [RUNNER_ENTRY], {
      env: {
        ...process.env,
        GANTRY_DEEPAGENTS_MODEL_ID: 'gpt-5.5',
        GANTRY_DEEPAGENTS_SESSIONS_DIR: input.sessionsDir,
        GANTRY_IPC_INPUT_DIR: input.inputDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(
      JSON.stringify({
        ...input.stdin,
        modelCredentialEnv: {
          OPENAI_BASE_URL: input.baseUrl,
          OPENAI_API_KEY: input.apiKey,
        },
      }),
    );
    child.stdin.end();
  });
}

const tempRoots: string[] = [];
function makeTempRoot(): { sessionsDir: string; inputDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-deepagents-int-'));
  tempRoots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const inputDir = path.join(root, 'ipc', 'input');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });
  return { sessionsDir, inputDir };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('DeepAgents (LangChain) runner boundary integration', () => {
  it('streams runner frames from a gateway-backed OpenAI run and persists the session', async () => {
    const gateway = await startFakeOpenAiGateway();
    const { sessionsDir, inputDir } = makeTempRoot();
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'say hello',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
        },
        sessionsDir,
        inputDir,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });

      expect(result.code).toBe(0);
      const frames = parseFrames(result.stdout);

      // First frame carries the session id immediately for durable persistence.
      expect(frames[0]).toMatchObject({ status: 'success', result: null });
      const sessionId = frames[0].newSessionId;
      expect(sessionId).toBeTruthy();
      expect(frames.every((frame) => frame.newSessionId === sessionId)).toBe(
        true,
      );

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
      // The OpenAI SDK appends /chat/completions to the projected gateway
      // baseUrl (.../openai); the real Gantry gateway maps that to
      // api.openai.com/v1/chat/completions (proven in the gateway unit test).
      for (const request of gateway.requests) {
        expect(request.authorization).toBe('Bearer gtw_integrationtoken');
        expect(request.path).toContain('/openai/chat/completions');
        expect(request.body).not.toContain('gtw_');
      }

      // Adapter-private session projection is persisted for live resume.
      const sessionFiles = fs.readdirSync(sessionsDir);
      expect(sessionFiles).toContain(`${sessionId}.json`);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, `${sessionId}.json`), 'utf-8'),
      ) as { version: number; messages: Array<{ role: string; text: string }> };
      expect(persisted.version).toBe(1);
      expect(persisted.messages.at(-1)).toEqual({
        role: 'ai',
        text: 'Hello Gantry',
      });
    } finally {
      await gateway.close();
    }
  }, 60_000);

  it('throws a stale-session error when resuming an unknown session id', async () => {
    const gateway = await startFakeOpenAiGateway();
    const { sessionsDir, inputDir } = makeTempRoot();
    try {
      const result = await runRunner({
        stdin: {
          prompt: 'resume please',
          workspaceFolder: 'group',
          chatJid: 'tg:group',
          sessionId: 'missing-session-id',
        },
        sessionsDir,
        inputDir,
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
  }, 60_000);

  it('runs an ephemeral scheduled job without persisting a session file', async () => {
    const gateway = await startFakeOpenAiGateway();
    const { sessionsDir, inputDir } = makeTempRoot();
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
        sessionsDir,
        inputDir,
        baseUrl: gateway.baseUrl,
        apiKey: 'gtw_integrationtoken',
      });

      expect(result.code).toBe(0);
      const frames = parseFrames(result.stdout);
      expect(frames.some((frame) => frame.usage)).toBe(true);
      // Scheduled jobs are ephemeral: no session file is written.
      expect(fs.readdirSync(sessionsDir)).toEqual([]);
    } finally {
      await gateway.close();
    }
  }, 60_000);
});
