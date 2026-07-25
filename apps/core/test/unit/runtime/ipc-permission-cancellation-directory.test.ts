import { randomUUID } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cancellationTestState = vi.hoisted(() => ({
  dataDir: `/tmp/gantry-cancellation-directory-data-${process.pid}`,
}));

vi.mock('@core/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/config/index.js')>()),
  DATA_DIR: cancellationTestState.dataDir,
  GANTRY_IPC_AUTH_SECRET: 'cancellation-directory-test-secret',
}));

import { createSignedIpcRequestEnvelope } from '@core/shared/ipc-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';
import { interactionInFlightKey } from '@core/runtime/ipc-interaction-processing.js';
import { processPermissionCancellationDirectory } from '@core/runtime/ipc-permission-cancellation-directory.js';
import { processQuestionCancellationDirectory } from '@core/runtime/ipc-question-cancellation-directory.js';

const SOURCE_AGENT_FOLDER = 'team';
const THREAD_ID = 'thread-1';
const RETRY_WAIT_MS = 1_500;
const RETENTION_TTL_MS = 24 * 60 * 60_000;

type CancellationKind = 'permission' | 'user-question';
type CancellationResult = 'settled' | 'queued' | 'not_found';

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  clearConsumedIpcRequestIds({ durable: true });
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe.each([
  ['permission', 'permission-cancellations'],
  ['user-question', 'question-cancellations'],
] as const)('%s cancellation directory', (kind, lane) => {
  it('retains a cancellation until the interaction is registered, then settles it', async () => {
    const fixture = createFixture(kind, lane);
    const cancel = vi.fn(async () => 'settled' as const);

    await fixture.process(cancel);

    expect(cancel).not.toHaveBeenCalled();
    expect(fixture.pendingFiles()).toEqual([fixture.file]);

    fixture.inFlight.add(fixture.inFlightKey);
    advancePastRetry();
    await fixture.process(cancel);

    expect(fixture.logger.error.mock.calls).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.pendingFiles()).toEqual([]);
  });

  it.each(['not_found', 'queued'] as const)(
    'retains a %s cancellation result and settles it on a later retry',
    async (firstResult) => {
      const fixture = createFixture(kind, lane);
      fixture.inFlight.add(fixture.inFlightKey);
      const cancel = vi
        .fn<() => Promise<CancellationResult>>()
        .mockResolvedValueOnce(firstResult)
        .mockResolvedValueOnce('settled');

      await fixture.process(cancel);
      await fixture.process(cancel);

      expect(cancel).toHaveBeenCalledOnce();
      expect(fixture.pendingFiles()).toEqual([fixture.file]);

      advancePastRetry();
      await fixture.process(cancel);

      expect(fixture.logger.error.mock.calls).toEqual([]);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(fixture.pendingFiles()).toEqual([]);
    },
  );

  it('retains a cancellation when the handler throws and settles it on a later retry', async () => {
    const fixture = createFixture(kind, lane);
    fixture.inFlight.add(fixture.inFlightKey);
    const cancellationFailure = new Error('cancellation persistence failed');
    const cancel = vi
      .fn<() => Promise<CancellationResult>>()
      .mockRejectedValueOnce(cancellationFailure)
      .mockResolvedValueOnce('settled');

    await fixture.process(cancel);
    await fixture.process(cancel);

    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.pendingFiles()).toEqual([fixture.file]);
    expect(fixture.laneFiles()).toEqual([
      fixture.file,
      `${fixture.file}.retry`,
    ]);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: cancellationFailure }),
      expect.stringContaining('Error processing'),
    );

    advancePastRetry();
    await fixture.process(cancel);

    expect(cancel).toHaveBeenCalledTimes(2);
    expect(fixture.pendingFiles()).toEqual([]);
    expect(fixture.laneFiles()).toEqual([]);
  });

  it('consumes a settled cancellation exactly once', async () => {
    const fixture = createFixture(kind, lane);
    fixture.inFlight.add(fixture.inFlightKey);
    const cancel = vi.fn(async () => 'settled' as const);

    await fixture.process(cancel);
    await fixture.process(cancel);

    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.pendingFiles()).toEqual([]);
    expect(fixture.laneFiles()).toEqual([]);
  });

  it('accepts a retained cancellation after restart and still rejects a duplicate replay', async () => {
    const fixture = createFixture(kind, lane);
    const cancel = vi.fn(async () => 'settled' as const);

    await fixture.process(cancel);
    expect(fixture.pendingFiles()).toEqual([fixture.file]);
    expect(fixture.laneFiles()).toEqual([
      fixture.file,
      `${fixture.file}.retry`,
    ]);

    await fixture.restart();
    fixture.inFlight.add(fixture.inFlightKey);
    await fixture.process(cancel);
    expect(cancel).not.toHaveBeenCalled();

    advancePastRetry();
    await fixture.process(cancel);

    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.pendingFiles()).toEqual([]);
    expect(fixture.laneFiles()).toEqual([]);

    fixture.writeEnvelope(fixture.envelope);
    await fixture.process(cancel);

    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.pendingFiles()).toEqual([]);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          message: expect.stringContaining('replay'),
        }),
      }),
      expect.stringContaining('Error processing'),
    );
  });

  it('accepts and settles a cancellation more than five minutes after it was written', async () => {
    const writtenAt = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(writtenAt);
    const fixture = createFixture(kind, lane);
    fixture.inFlight.add(fixture.inFlightKey);
    const cancel = vi.fn(async () => 'settled' as const);

    vi.setSystemTime(writtenAt + 6 * 60_000);
    await fixture.process(cancel);

    expect(fixture.logger.error.mock.calls).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.pendingFiles()).toEqual([]);
  });

  it('rejects a cancellation after the 24-hour authentication and retention bound', async () => {
    const writtenAt = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(writtenAt);
    const fixture = createFixture(kind, lane);
    fixture.inFlight.add(fixture.inFlightKey);
    const cancel = vi.fn(async () => 'settled' as const);

    vi.setSystemTime(writtenAt + RETENTION_TTL_MS + 1);
    await fixture.process(cancel);

    expect(cancel).not.toHaveBeenCalled();
    expect(fixture.pendingFiles()).toEqual([]);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          message: expect.stringContaining('expired request'),
        }),
      }),
      expect.stringContaining('Error processing'),
    );
  });

  it('rejects a cancellation whose signed payload was tampered', async () => {
    const fixture = createFixture(kind, lane);
    fixture.inFlight.add(fixture.inFlightKey);
    fixture.writeEnvelope({
      ...fixture.envelope,
      reason: 'Tampered cancellation reason.',
    });
    const cancel = vi.fn(async () => 'settled' as const);

    await fixture.process(cancel);

    expect(cancel).not.toHaveBeenCalled();
    expect(fixture.pendingFiles()).toEqual([]);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          message: expect.stringContaining('signature'),
        }),
      }),
      expect.stringContaining('Error processing'),
    );
  });

  it('rejects a duplicated cancellation envelope after settlement', async () => {
    const fixture = createFixture(kind, lane);
    fixture.inFlight.add(fixture.inFlightKey);
    const cancel = vi.fn(async () => 'settled' as const);

    await fixture.process(cancel);
    fixture.writeEnvelope(fixture.envelope);
    await fixture.process(cancel);

    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.pendingFiles()).toEqual([]);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          message: expect.stringContaining('replay'),
        }),
      }),
      expect.stringContaining('Error processing'),
    );
  });

  it('expires a retained cancellation at the 24-hour GC bound', async () => {
    const fixture = createFixture(kind, lane);
    const staleAt = new Date(Date.now() - RETENTION_TTL_MS - 1);
    fs.utimesSync(fixture.filePath, staleAt, staleAt);
    const cancel = vi.fn(async () => 'settled' as const);

    await fixture.process(cancel);

    expect(cancel).not.toHaveBeenCalled();
    expect(fixture.pendingFiles()).toEqual([]);
    expect(fixture.logger.warn).toHaveBeenCalledOnce();
  });
});

function createFixture(
  kind: CancellationKind,
  lane: 'permission-cancellations' | 'question-cancellations',
) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-cancellation-directory-'),
  );
  tempDirs.push(tempDir);
  const runnerControlPort = new FilesystemRunnerControlPort(
    path.join(tempDir, 'ipc'),
  );
  runnerControlPort.ensureRoot();
  runnerControlPort.ensureWorkspaceLayout(SOURCE_AGENT_FOLDER);
  const requestId = `${kind}-${randomUUID()}`;
  const file = `${requestId}.json`;
  const filePath = path.join(
    runnerControlPort.requestDir(SOURCE_AGENT_FOLDER, lane),
    file,
  );
  const envelope = cancellationEnvelope(kind, requestId);
  const writeEnvelope = (value: Record<string, unknown>) =>
    fs.writeFileSync(filePath, JSON.stringify(value));
  writeEnvelope(envelope);
  const inFlight = new Set<string>();
  const inFlightKey = interactionInFlightKey({
    sourceAgentFolder: SOURCE_AGENT_FOLDER,
    kind,
    threadId: THREAD_ID,
    requestId,
  });
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
  };
  let permissionProcessor = processPermissionCancellationDirectory;
  let questionProcessor = processQuestionCancellationDirectory;

  return {
    file,
    filePath,
    envelope,
    inFlight,
    inFlightKey,
    logger,
    writeEnvelope,
    laneFiles: () =>
      fs
        .readdirSync(runnerControlPort.requestDir(SOURCE_AGENT_FOLDER, lane))
        .sort(),
    pendingFiles: () =>
      runnerControlPort.listPendingRequests(SOURCE_AGENT_FOLDER, lane),
    restart: async () => {
      vi.resetModules();
      if (kind === 'permission') {
        permissionProcessor = (
          await import('@core/runtime/ipc-permission-cancellation-directory.js')
        ).processPermissionCancellationDirectory;
      } else {
        questionProcessor = (
          await import('@core/runtime/ipc-question-cancellation-directory.js')
        ).processQuestionCancellationDirectory;
      }
    },
    process: async (
      cancel: ReturnType<typeof vi.fn<() => Promise<CancellationResult>>>,
    ) => {
      const common = {
        sourceAgentFolder: SOURCE_AGENT_FOLDER,
        shouldProcessRequestLane: () => true,
        inFlightInteractionIpc: inFlight,
        runnerControlPort,
        logger,
      };
      if (kind === 'permission') {
        await permissionProcessor({
          ...common,
          cancelPermissionApproval: cancel as never,
        });
      } else {
        await questionProcessor({
          ...common,
          cancelUserQuestion: cancel as never,
        });
      }
    },
  };
}

function cancellationEnvelope(kind: CancellationKind, requestId: string) {
  const auth = createIpcAuthEnvelope(SOURCE_AGENT_FOLDER, THREAD_ID, {
    appId: 'default',
    agentId: `agent:${SOURCE_AGENT_FOLDER}`,
  });
  return createSignedIpcRequestEnvelope(
    auth.authToken,
    {
      requestId: `${kind}-cancel-${randomUUID()}`,
      ...(kind === 'permission'
        ? { permissionRequestId: requestId }
        : { questionRequestId: requestId }),
      appId: 'default',
      sourceAgentFolder: SOURCE_AGENT_FOLDER,
      reason:
        kind === 'permission'
          ? 'Permission request cancelled.'
          : 'Question cancelled. Nothing changed.',
      context: {
        appId: 'default',
        agentId: `agent:${SOURCE_AGENT_FOLDER}`,
        threadId: THREAD_ID,
      },
      timestamp: new Date().toISOString(),
    },
    {
      separateAuthExpiry: true,
      authLifetimeMs: RETENTION_TTL_MS,
      authPurpose: 'cancellation-retention',
    },
  );
}

function advancePastRetry(): void {
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now + RETRY_WAIT_MS);
}
