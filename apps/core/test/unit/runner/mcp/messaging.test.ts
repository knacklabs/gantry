import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveInteractionSettlementDelayMs } from '@core/channels/interaction-settlement.js';
import {
  validateIpcRequestFreshness,
  verifyIpcRequestPayload,
} from '@core/infrastructure/ipc/request-signing.js';
import { IPC_INTERACTION_RETENTION_TTL_MS } from '@core/shared/ipc-interaction-lifetime.js';

const contextState = vi.hoisted(() => ({
  ipcDir: '',
  jobId: undefined as string | undefined,
  permissionLane: 'autonomous' as 'autonomous' | 'interactive',
}));
const CANCELLATION_LIFETIME_MS = 24 * 60 * 60_000;

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
  get permissionLane() {
    return contextState.permissionLane;
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

async function askUserQuestionHandler(options?: {
  claimProbe?: (requestPath: string) => boolean;
}): Promise<
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
  registerMessagingTools(server as never, options?.claimProbe);
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

type SignedQuestionRequest = Record<string, unknown> & {
  requestId: string;
  expiresAt?: string;
  permissionLane?: string;
  authPurpose?: string;
  authExpiresAt?: string;
  signature?: string;
};

function expectValidRequestAuth(
  request: SignedQuestionRequest,
  maxAgeMs?: number,
): void {
  const { signature, ...payload } = request;
  expect(signature).toEqual(expect.any(String));
  expect(
    verifyIpcRequestPayload('messaging-test-token', payload, signature),
  ).toBe(true);
  expect(validateIpcRequestFreshness(payload, Date.now(), maxAgeMs)).toEqual({
    ok: true,
  });
}

describe('ask_user_question lane deadlines', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-messaging-'));
    contextState.ipcDir = path.join(tempDir, 'ipc');
    contextState.jobId = undefined;
    contextState.permissionLane = 'autonomous';
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('waits for a claimed interactive question beyond the auth TTL until answered', async () => {
    vi.stubEnv('GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS', '0');
    contextState.permissionLane = 'interactive';
    vi.useFakeTimers();
    const claimProbe = vi
      .fn<(requestPath: string) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const handler = await askUserQuestionHandler({ claimProbe });
    let settled = false;
    const result = handler(questionArgs);
    void result.then(() => {
      settled = true;
    });

    const boundaryDir = path.join(
      contextState.ipcDir,
      'interaction-boundaries',
    );
    const [boundaryFile] = fs.readdirSync(boundaryDir);
    fs.unlinkSync(path.join(boundaryDir, boundaryFile));
    await vi.advanceTimersByTimeAsync(100);

    const requestDir = path.join(contextState.ipcDir, 'user-questions');
    const [requestFile] = fs
      .readdirSync(requestDir)
      .filter((entry) => entry.endsWith('.json'));
    const requestPath = path.join(requestDir, requestFile);
    const request = JSON.parse(
      fs.readFileSync(requestPath, 'utf8'),
    ) as SignedQuestionRequest;
    expect(request.expiresAt).toBeUndefined();
    expect(request.authExpiresAt).toEqual(expect.any(String));
    expect(request).toMatchObject({
      permissionLane: 'interactive',
      authPurpose: 'unbounded-interaction',
    });
    expectValidRequestAuth(request, IPC_INTERACTION_RETENTION_TTL_MS);
    expect(
      resolveInteractionSettlementDelayMs({
        expiresAt: request.expiresAt,
        permissionLane: 'interactive',
        fallbackTimeoutMs: 5 * 60_000,
      }),
    ).toBeUndefined();
    expect(claimProbe).toHaveBeenCalledWith(requestPath);

    vi.setSystemTime(Date.parse(request.authExpiresAt!) + 60_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(claimProbe).toHaveBeenCalledOnce();

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
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'Ship now?: Yes\n(answered by Ravi)',
        },
      ],
    });
  });

  it('returns a clear failure when an unclaimed interactive question reaches its ingestion bound', async () => {
    contextState.permissionLane = 'interactive';
    const handler = await askUserQuestionHandler();
    const result = handler(questionArgs);
    await passInteractionBoundary();

    const requestDir = path.join(contextState.ipcDir, 'user-questions');
    const requestFile = await waitForJsonFile(requestDir);
    const requestPath = path.join(requestDir, requestFile);
    const request = JSON.parse(
      fs.readFileSync(requestPath, 'utf8'),
    ) as SignedQuestionRequest;
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(request.authExpiresAt!) + 1);

    await expect(result).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'Question could not be claimed before its authenticated ingestion window expired. Please ask again.',
        },
      ],
    });
    expect(fs.existsSync(requestPath)).toBe(false);
    dateNow.mockRestore();
  });

  it.each([
    { description: 'without a job id', jobId: undefined },
    { description: 'with a job id', jobId: 'job-1' },
  ])(
    'bounds autonomous questions $description and cleans them up after the finite deadline',
    async ({ jobId }) => {
      contextState.permissionLane = 'autonomous';
      contextState.jobId = jobId;
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
      const request = JSON.parse(
        fs.readFileSync(requestPath, 'utf8'),
      ) as SignedQuestionRequest;
      expect(request.expiresAt).toEqual(expect.any(String));
      expect(request.authExpiresAt).toEqual(expect.any(String));
      expectValidRequestAuth(request);
      const settlementDelayMs = resolveInteractionSettlementDelayMs({
        expiresAt: request.expiresAt,
        permissionLane: 'autonomous',
        fallbackTimeoutMs: 0,
      });
      expect(settlementDelayMs).toEqual(expect.any(Number));
      expect(settlementDelayMs).toBeGreaterThan(0);
      expect(settlementDelayMs).toBeLessThanOrEqual(5 * 60_000);

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
    },
  );

  it.each([
    { permissionLane: 'interactive' as const },
    { permissionLane: 'autonomous' as const },
  ])(
    'returns the cancellation result when the $permissionLane lane is aborted',
    async ({ permissionLane }) => {
      contextState.permissionLane = permissionLane;
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

  it('signals the host when an interactive question was claimed before cancellation', async () => {
    contextState.permissionLane = 'interactive';
    const handler = await askUserQuestionHandler();
    const controller = new AbortController();
    const result = handler(questionArgs, { signal: controller.signal });
    await passInteractionBoundary();

    const requestDir = path.join(contextState.ipcDir, 'user-questions');
    const requestFile = await waitForJsonFile(requestDir);
    const requestPath = path.join(requestDir, requestFile);
    const request = JSON.parse(
      fs.readFileSync(requestPath, 'utf8'),
    ) as SignedQuestionRequest;
    fs.renameSync(
      requestPath,
      path.join(requestDir, `.processing-host-${requestFile}`),
    );

    controller.abort();

    await expect(result).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'Question cancelled. Nothing changed.',
        },
      ],
    });
    const cancellationDir = path.join(
      contextState.ipcDir,
      'question-cancellations',
    );
    const cancellationFile = await waitForJsonFile(cancellationDir);
    const cancellation = JSON.parse(
      fs.readFileSync(path.join(cancellationDir, cancellationFile), 'utf8'),
    ) as Record<string, unknown>;
    expect(cancellation).toMatchObject({
      questionRequestId: request.requestId,
      sourceAgentFolder: 'main_agent',
      reason: 'Question cancelled. Nothing changed.',
    });
    expect(cancellation).not.toHaveProperty('expiresAt');
    expect(
      Date.parse(String(cancellation.authExpiresAt)) - Date.now(),
    ).toBeGreaterThanOrEqual(CANCELLATION_LIFETIME_MS - 100);
    expectValidRequestAuth(
      cancellation as SignedQuestionRequest,
      CANCELLATION_LIFETIME_MS,
    );
  });
});
