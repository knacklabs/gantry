import { randomUUID } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSignedIpcRequestEnvelope } from '@core/shared/ipc-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
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

  it('consumes a settled cancellation exactly once', async () => {
    const fixture = createFixture(kind, lane);
    fixture.inFlight.add(fixture.inFlightKey);
    const cancel = vi.fn(async () => 'settled' as const);

    await fixture.process(cancel);
    await fixture.process(cancel);

    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.pendingFiles()).toEqual([]);
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
  fs.writeFileSync(
    filePath,
    JSON.stringify(cancellationEnvelope(kind, requestId)),
  );
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

  return {
    file,
    filePath,
    inFlight,
    inFlightKey,
    logger,
    pendingFiles: () =>
      runnerControlPort.listPendingRequests(SOURCE_AGENT_FOLDER, lane),
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
        await processPermissionCancellationDirectory({
          ...common,
          cancelPermissionApproval: cancel as never,
        });
      } else {
        await processQuestionCancellationDirectory({
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
  return createSignedIpcRequestEnvelope(auth.authToken, {
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
  });
}

function advancePastRetry(): void {
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now + RETRY_WAIT_MS);
}
