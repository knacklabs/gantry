import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contextState = vi.hoisted(() => ({
  ipcDir: '',
  jobId: undefined as string | undefined,
}));

vi.mock('@core/runner/mcp/context.js', () => ({
  agentId: 'agent:main_agent',
  appId: 'default',
  chatJid: 'tg:test',
  providerAccountId: 'telegram_default',
  workspaceFolder: 'main_agent',
  IPC_AUTH_TOKEN: 'messaging-test-token',
  get IPC_DIR() {
    return contextState.ipcDir;
  },
  IPC_RESPONSE_KEY_ID: 'test-response-key',
  get MESSAGES_DIR() {
    return path.join(contextState.ipcDir, 'messages');
  },
  threadId: undefined,
  get jobId() {
    return contextState.jobId;
  },
  jobRunId: undefined,
  jobRunLeaseToken: undefined,
  jobRunLeaseFencingVersion: undefined,
}));

vi.mock('@core/runner/mcp/ipc.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/runner/mcp/ipc.js')
  >('@core/runner/mcp/ipc.js');
  return {
    ...actual,
    hasValidIpcResponseSignature: vi.fn(() => true),
  };
});

vi.mock('@core/shared/ipc-signing.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/shared/ipc-signing.js')
  >('@core/shared/ipc-signing.js');
  return {
    ...actual,
    createSignedIpcRequestEnvelope: vi.fn(
      (_key: string | undefined, payload: Record<string, unknown>) => ({
        ...payload,
        nonce: '00000000-0000-4000-8000-000000000000',
        signature: 'test-signature',
      }),
    ),
  };
});

async function waitForJsonFile(dir: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const file = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((entry) => entry.endsWith('.json'))
      : undefined;
    if (file) return file;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for JSON file in ${dir}`);
}

async function askUserQuestionHandler(): Promise<
  (
    args: Record<string, unknown>,
    context?: { signal?: AbortSignal },
  ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
> {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const server = {
    tool: (...args: unknown[]) => {
      const name = String(args[0]);
      const handler = args.at(-1);
      if (typeof handler === 'function') {
        handlers.set(name, handler as (...args: never[]) => unknown);
      }
    },
  };
  const { registerMessagingTools } =
    await import('@core/runner/mcp/tools/messaging.js');
  registerMessagingTools(server as never);
  const handler = handlers.get('ask_user_question');
  if (!handler) throw new Error('ask_user_question was not registered');
  return handler as never;
}

async function passInteractionBoundary(): Promise<void> {
  const boundaryDir = path.join(contextState.ipcDir, 'interaction-boundaries');
  const boundaryFile = await waitForJsonFile(boundaryDir);
  fs.unlinkSync(path.join(boundaryDir, boundaryFile));
}

const questionArgs = {
  questions: [
    {
      question: 'Ship now?',
      header: 'Ship',
      options: [
        { label: 'Yes', description: 'Proceed' },
        { label: 'No', description: 'Wait' },
      ],
      multiSelect: false,
    },
  ],
};

describe('ask_user_question no-timeout wait', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-messaging-'));
    contextState.ipcDir = path.join(tempDir, 'ipc');
    contextState.jobId = undefined;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('has no deadline and waits beyond the former expiry until answered', async () => {
    const handler = await askUserQuestionHandler();
    let settled = false;
    const result = handler(questionArgs);
    void result.then(() => {
      settled = true;
    });
    await passInteractionBoundary();

    const requestDir = path.join(contextState.ipcDir, 'user-questions');
    const requestFile = await waitForJsonFile(requestDir);
    const request = JSON.parse(
      fs.readFileSync(path.join(requestDir, requestFile), 'utf8'),
    ) as { requestId: string; expiresAt?: string };
    expect(request.expiresAt).toBeUndefined();

    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 10 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    dateNow.mockRestore();

    const responseDir = path.join(contextState.ipcDir, 'user-answers');
    fs.mkdirSync(responseDir, { recursive: true });
    fs.writeFileSync(
      path.join(responseDir, `${request.requestId}.json`),
      JSON.stringify({
        requestId: request.requestId,
        answers: { 'Ship now?': 'Yes' },
        answeredBy: 'Ravi',
        signature: 'test-signature',
      }),
    );

    await expect(result).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'Ship now?: Yes\n(answered by Ravi)',
        },
      ],
    });
  });

  it('bounds job questions and cleans them up after the finite deadline', async () => {
    contextState.jobId = 'job-1';
    const handler = await askUserQuestionHandler();
    vi.useFakeTimers();
    const result = handler(questionArgs);

    const boundaryDir = path.join(
      contextState.ipcDir,
      'interaction-boundaries',
    );
    const boundaryFile = fs
      .readdirSync(boundaryDir)
      .find((entry) => entry.endsWith('.json'));
    expect(boundaryFile).toBeDefined();
    fs.unlinkSync(path.join(boundaryDir, boundaryFile!));
    await vi.advanceTimersByTimeAsync(100);

    const requestDir = path.join(contextState.ipcDir, 'user-questions');
    const requestFile = fs
      .readdirSync(requestDir)
      .find((entry) => entry.endsWith('.json'));
    expect(requestFile).toBeDefined();
    const requestPath = path.join(requestDir, requestFile!);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as {
      expiresAt?: string;
    };
    expect(request.expiresAt).toBeDefined();

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'Question expired. Please ask again if this is still needed.',
        },
      ],
    });
    expect(fs.existsSync(requestPath)).toBe(false);
  });

  it.each([
    { lane: 'interactive', jobId: undefined },
    { lane: 'job', jobId: 'job-1' },
  ])(
    'returns the cancellation result when the $lane lane is aborted',
    async ({ jobId }) => {
      contextState.jobId = jobId;
      const handler = await askUserQuestionHandler();
      const controller = new AbortController();
      const result = handler(questionArgs, { signal: controller.signal });
      await passInteractionBoundary();

      const requestDir = path.join(contextState.ipcDir, 'user-questions');
      const requestFile = await waitForJsonFile(requestDir);
      const requestPath = path.join(requestDir, requestFile);
      controller.abort();

      await expect(result).resolves.toEqual({
        content: [
          {
            type: 'text',
            text: 'Question cancelled. Nothing changed.',
          },
        ],
      });
      expect(fs.existsSync(requestPath)).toBe(false);
    },
  );
});
