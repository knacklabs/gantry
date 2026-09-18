import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withIsolatedValidationBrowserSession: vi.fn(),
  resolvePublicEgressAddress: vi.fn(),
  isActiveRunLeaseForInteraction: vi.fn(async () => true),
}));

vi.mock(
  '@core/application/interactions/pending-interaction-durability.js',
  () => ({
    isActiveRunLeaseForInteraction: mocks.isActiveRunLeaseForInteraction,
  }),
);

vi.mock('@core/runtime/browser-isolated-validation-session.js', () => ({
  withIsolatedValidationBrowserSession:
    mocks.withIsolatedValidationBrowserSession,
}));
vi.mock('@core/shared/egress-target-resolution.js', () => ({
  resolvePublicEgressAddress: mocks.resolvePublicEgressAddress,
}));

import {
  createConfiguredGantryHostedCapabilityRunner,
  fetchForValidation,
  HostedCapabilityExecutionDeadlineError,
} from '@core/runtime/gantry-hosted-capability-module-runner.js';
import { jobArtifactScope } from '@core/domain/ports/job-semantic-checkpoints.js';
import { stableSha256Json } from '@core/shared/stable-hash.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  mocks.isActiveRunLeaseForInteraction.mockImplementation(async () => true);
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('signed Gantry-hosted capability module runner', () => {
  it.each(['active', 'lost-during-read'] as const)(
    'keeps parent leases host-owned and rechecks durable reads: %s',
    async (scenario) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-hosted-'),
      );
      temporaryDirectories.push(directory);
      const modulePath = path.join(directory, 'runner.mjs');
      const source = `export async function execute(input) { if ('parentRunLease' in input) throw Error('lease exposed'); return { status: 'needs_review' }; }`;
      fs.writeFileSync(modulePath, source);
      let active = true;
      mocks.isActiveRunLeaseForInteraction.mockImplementation(
        async () => active,
      );
      const runner = createConfiguredGantryHostedCapabilityRunner({
        env: JSON.stringify([
          {
            capabilityId: runInput().capabilityId,
            operation: 'validate_recipe',
            modulePath,
            sha256: createHash('sha256').update(source).digest('hex'),
          },
        ]),
        getAsyncTaskRepository: () =>
          ({
            getTask: async () => {
              if (scenario === 'lost-during-read') active = false;
              return validationTask();
            },
          }) as never,
        getFileArtifactStore: () => undefined,
        openBrowserSession: vi.fn(),
      });
      const promise = runner!.execute({
        ...runInput(),
        parentRunLease: { leaseToken: 'parent-token', fencingVersion: 1 },
      });
      if (scenario === 'active')
        await expect(promise).resolves.toMatchObject({
          status: 'needs_review',
        });
      else await expect(promise).rejects.toThrow(/parent run lease/);
    },
  );

  it('rejects POST on a GET/HEAD-approved origin before network access', async () => {
    await expect(
      fetchForValidation({
        request: { url: 'https://example.test/data', method: 'POST' },
        allowedOrigins: new Set(['https://example.test']),
        allowedMethodsByOrigin: { 'https://example.test': ['GET', 'HEAD'] },
        deadlineAtMs: Date.now() + 1000,
        maxResponseBytes: 1000,
      }),
    ).rejects.toThrow(/method is not allowed/);
    expect(mocks.resolvePublicEgressAddress).not.toHaveBeenCalled();
  });
  it.each(['valid', 'oversized', 'lease-lost'] as const)(
    'persists bounded task-owned binary artifacts: %s',
    async (scenario) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-hosted-'),
      );
      temporaryDirectories.push(directory);
      const modulePath = path.join(directory, 'runner.mjs');
      const source = `export async function execute(_input, host) {
        return await host.writeBinaryArtifact({ bodyBase64: 'aGVsbG8=', contentType: 'application/pdf' });
      }`;
      fs.writeFileSync(modulePath, source);
      let task = validationTask();
      const writeFileArtifact = vi.fn(async (input) => {
        if (scenario === 'lease-lost')
          task = { ...task, fencingVersion: 2 } as never;
        return {
          id: 'file-artifact:22222222-2222-4222-8222-222222222222',
          contentHash: `sha256:${createHash('sha256').update(input.content).digest('hex')}`,
          sizeBytes: input.content.length,
          contentType: input.contentType,
        };
      });
      const runner = createConfiguredGantryHostedCapabilityRunner({
        env: JSON.stringify([
          {
            capabilityId: runInput().capabilityId,
            operation: 'validate_recipe',
            modulePath,
            sha256: createHash('sha256').update(source).digest('hex'),
          },
        ]),
        getFileArtifactStore: () => ({ writeFileArtifact }) as never,
        getAsyncTaskRepository: () => ({ getTask: async () => task }) as never,
        openBrowserSession: vi.fn(),
      });
      const executing = runner!.execute({
        ...runInput(),
        runtimeContext: {
          ...runInput().runtimeContext,
          runtimeLimits: {
            maxDocumentBytes: scenario === 'oversized' ? 4 : 10,
          },
        },
      });
      if (scenario === 'valid') {
        const result = await executing;
        expect(result).toMatchObject({
          sizeBytes: 5,
          contentHash: `sha256:${createHash('sha256').update('hello').digest('hex')}`,
        });
        expect(writeFileArtifact).toHaveBeenCalledWith(
          expect.objectContaining({
            appId: 'app:test',
            agentId: 'agent:test',
            virtualScope: jobArtifactScope('job-1'),
            content: Buffer.from('hello'),
            contentType: 'application/pdf',
          }),
        );
      } else {
        await expect(executing).rejects.toThrow(
          scenario === 'oversized' ? /size limit/ : /lease changed/,
        );
        if (scenario === 'oversized')
          expect(writeFileArtifact).not.toHaveBeenCalled();
      }
    },
  );
  it('bounds a stalled legacy reconstruction task read by the absolute deadline', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute() { return { status: 'needs_review' }; }`;
    fs.writeFileSync(modulePath, source);
    const task = {
      ...validationTask(),
      privateCorrelationJson: {
        hostedCommit: {
          status: 'submitted',
          operation: 'validation_commit',
          argumentsSha256: stableSha256Json(runInput().arguments),
          payloadSha256: 'a'.repeat(64),
          runnerAttestation: {
            sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          },
        },
      },
    };
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(task)
      .mockImplementation(() => new Promise(() => undefined));
    const commit = vi.fn();
    const openBrowserSession = vi.fn();
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256: createHash('sha256').update(source).digest('hex'),
          resultCommitOperation: 'validation_commit',
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () => ({ getTask }) as never,
      openBrowserSession,
    });
    await expect(
      runner?.execute({ ...runInput(), deadlineMs: 25 }, commit),
    ).rejects.toBeInstanceOf(HostedCapabilityExecutionDeadlineError);
    expect(openBrowserSession).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  }, 500);

  it('reports an executable-module deadline as a typed retryable boundary', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: 'proven' };
    }`;
    fs.writeFileSync(modulePath, source);
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: runInput().capabilityId,
          operation: 'validate_recipe',
          modulePath,
          sha256: createHash('sha256').update(source).digest('hex'),
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({ getTask: vi.fn(async () => validationTask()) }) as never,
      openBrowserSession: vi.fn(),
    });

    await expect(runner?.execute({ ...runInput(), deadlineMs: 10 })).rejects.toBeInstanceOf(
      HostedCapabilityExecutionDeadlineError,
    );
  }, 500);
  it('replays a legacy acknowledged result without inventing an attestation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute() { throw new Error('An acknowledged result must not execute again.'); }`;
    fs.writeFileSync(modulePath, source);
    const result = { status: 'proven', evaluationId: 'evaluation-legacy' };
    const task = {
      ...validationTask(),
      privateCorrelationJson: {
        hostedCommit: {
          status: 'acknowledged',
          operation: 'validation_commit',
          argumentsSha256: stableSha256Json(runInput().arguments),
          payloadSha256: 'a'.repeat(64),
          result,
          resultSha256: stableSha256Json(result),
        },
      },
    };
    const commit = vi.fn();
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256: createHash('sha256').update(source).digest('hex'),
          resultCommitOperation: 'validation_commit',
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () => ({ getTask: async () => task }) as never,
      openBrowserSession: vi.fn(),
    });
    await expect(runner?.execute(runInput(), commit)).resolves.toEqual(result);
    expect(commit).not.toHaveBeenCalled();
    expect(task.privateCorrelationJson.hostedCommit).not.toHaveProperty(
      'runnerAttestation',
    );
  });
  it('reconciles a submitted hosted proof before opening a new browser session', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute() { throw new Error('submitted proof must reconcile before validation executes'); }`;
    fs.writeFileSync(modulePath, source);
    const result = { status: 'proven', evaluationId: 'evaluation-reconciled' };
    let task = {
      ...validationTask(),
      privateCorrelationJson: {
        hostedCommit: {
          status: 'submitted',
          operation: 'validation_commit',
          argumentsSha256: stableSha256Json(runInput().arguments),
          payloadSha256: 'a'.repeat(64),
          runnerAttestation: {
            sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          },
        },
      },
    };
    const commit = vi.fn(async (operation: string) => {
      expect(operation).toBe('validation_reconcile');
      return { status: 'acknowledged', result };
    });
    const openBrowserSession = vi.fn();
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256: createHash('sha256').update(source).digest('hex'),
          resultCommitOperation: 'validation_commit',
          resultReconcileOperation: 'validation_reconcile',
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({
          getTask: async () => task,
          transitionTask: async (input: {
            privateCorrelationJson: Record<string, unknown>;
          }) => {
            task = { ...task, privateCorrelationJson: input.privateCorrelationJson };
            return task;
          },
        }) as never,
      openBrowserSession,
    });

    await expect(runner?.execute(runInput(), commit)).resolves.toEqual(result);
    expect(openBrowserSession).not.toHaveBeenCalled();
    expect(task.privateCorrelationJson.hostedCommit).toMatchObject({
      status: 'acknowledged',
      result,
    });
  });
  it.each(['current', 'legacy', 'legacy HTTP', 'legacy incompatible browser'])(
    'reconciles %s submitted validation without changing proof content',
    async (format) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-hosted-'),
      );
      temporaryDirectories.push(directory);
      const modulePath = path.join(directory, 'runner.mjs');
      const source =
        format === 'legacy HTTP'
          ? `export async function execute() { return { status: 'needs_review' }; }`
          : `export async function execute(_input, host) {
      const saved = await host.readValidationCheckpoint();
      if (!saved.completedCases.listing) await host.withBrowserSession(async () => {
        await host.saveValidationCase({ caseId: 'listing', result: { status: 'passed' } });
      });
      return { status: 'needs_review' };
    }`;
      fs.writeFileSync(modulePath, source);
      let task = validationTask();
      let browserVersion = '147.0.test';
      mocks.withIsolatedValidationBrowserSession.mockImplementation(
        async (input) =>
          input.execute({
            context: { browser: () => ({ version: () => browserVersion }) },
          }),
      );
      const openBrowserSession = vi.fn(async () => ({
        cdpReady: true,
        port: 9999,
        chromeExecutable: modulePath,
      }));
      const runner = createConfiguredGantryHostedCapabilityRunner({
        env: JSON.stringify([
          {
            capabilityId: 'manipal.website-recipe-evaluator@13',
            operation: 'validate_recipe',
            modulePath,
            sha256: createHash('sha256').update(source).digest('hex'),
            resultCommitOperation: 'validation_commit',
            resultReconcileOperation: 'validation_reconcile',
          },
        ]),
        getFileArtifactStore: () => undefined,
        getAsyncTaskRepository: () =>
          ({
            getTask: async () => task,
            transitionTask: async (input: {
              privateCorrelationJson: Record<string, unknown>;
            }) => {
              task = {
                ...task,
                privateCorrelationJson: input.privateCorrelationJson,
              };
              return task;
            },
          }) as never,
        openBrowserSession: openBrowserSession as never,
        closeBrowserSession: vi.fn(),
      });
      const commit = vi.fn(async (operation: string) => {
        if (operation === 'validation_reconcile') {
          return {
            status: 'acknowledged',
            result: { status: 'proven', evaluationId: 'evaluation-resumed' },
          };
        }
        const count = commit.mock.calls.filter(
          ([candidate]) => candidate === 'validation_commit',
        ).length;
        if (count === 1) throw new Error('network connection lost');
        return { status: 'proven', evaluationId: 'evaluation-resumed' };
      });
      await expect(
        runner?.execute({ ...runInput(), deadlineMs: 600_000 }, commit),
      ).rejects.toThrow('commit outcome is uncertain');
      if (format !== 'legacy HTTP') {
        expect(openBrowserSession).toHaveBeenCalledWith(
          expect.stringMatching(/^hosted-validation-/),
          expect.objectContaining({
            deadlineAtMs: expect.any(Number),
            keepAliveMs: expect.any(Number),
          }),
        );
        expect(
          (
            openBrowserSession.mock.calls[0] as unknown as [
              string,
              { keepAliveMs: number },
            ]
          )[1].keepAliveMs,
        ).toBeGreaterThan(300_000);
      }
      if (format.startsWith('legacy')) {
        const saved = task.privateCorrelationJson as Record<string, unknown>;
        const state = { ...(saved.hostedCommit as Record<string, unknown>) };
        delete state.runnerAttestation;
        task = {
          ...task,
          privateCorrelationJson: { ...saved, hostedCommit: state },
        };
      }
      if (format === 'legacy incompatible browser') {
        browserVersion = '148.0.test';
        const saved = task.privateCorrelationJson;
        await expect(runner?.execute(runInput(), commit)).rejects.toMatchObject(
          {
            cause: {
              message: expect.stringContaining(
                'Reconcile the authoritative remote outcome',
              ),
            },
          },
        );
        expect(commit).toHaveBeenCalledOnce();
        expect(task.privateCorrelationJson).toEqual(saved);
        return;
      }
      await expect(runner?.execute(runInput(), commit)).resolves.toEqual({
        status: 'proven',
        evaluationId: 'evaluation-resumed',
      });
      if (format === 'current') {
        expect(commit.mock.calls[1]?.[0]).toBe('validation_reconcile');
      } else {
        expect(commit.mock.calls[1]?.[1]).toEqual(commit.mock.calls[0]?.[1]);
      }
      if (format === 'legacy HTTP')
        expect(
          mocks.withIsolatedValidationBrowserSession,
        ).not.toHaveBeenCalled();
    },
  );
  it.each(['before', 'during', 'at submission'])(
    'reconciles an acknowledgement arriving %s retry without submitting it twice',
    async (timing) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-hosted-'),
      );
      temporaryDirectories.push(directory);
      const modulePath = path.join(directory, 'runner.mjs');
      const source = `export async function execute(_input, host) { await host.readJsonArtifact('file-artifact:11111111-1111-4111-8111-111111111111'); return { status: 'needs_review' }; }`;
      fs.writeFileSync(modulePath, source);
      let task = validationTask();
      let onRead: () => Promise<void> = async () => undefined;
      let onSubmission: () => Promise<void> = async () => undefined;
      let submitted = false;
      const runner = createConfiguredGantryHostedCapabilityRunner({
        env: JSON.stringify([
          {
            capabilityId: 'manipal.website-recipe-evaluator@13',
            operation: 'validate_recipe',
            modulePath,
            sha256: createHash('sha256').update(source).digest('hex'),
            resultCommitOperation: 'validation_commit',
          },
        ]),
        getFileArtifactStore: () =>
          ({
            readFileArtifact: async () => {
              await onRead();
              return {
                artifact: {
                  virtualScope: jobArtifactScope('job-1'),
                  contentHash: 'sha256:fixture',
                },
                content: '{}',
              };
            },
          }) as never,
        getAsyncTaskRepository: () =>
          ({
            getTask: async () => {
              if (submitted) {
                submitted = false;
                await onSubmission();
              }
              return task;
            },
            transitionTask: async (input: {
              privateCorrelationJson: Record<string, unknown>;
            }) => {
              task = {
                ...task,
                privateCorrelationJson: input.privateCorrelationJson,
              };
              submitted =
                (
                  input.privateCorrelationJson.hostedCommit as
                    | Record<string, unknown>
                    | undefined
                )?.status === 'submitted';
              return task;
            },
          }) as never,
        openBrowserSession: vi.fn(),
      });
      let acknowledge: ((value: unknown) => void) | undefined;
      const commit = vi.fn((operation: string) => {
        if (operation === 'validation_reconcile') {
          return Promise.resolve({
            status: 'acknowledged',
            result: { status: 'proven', evaluationId: 'evaluation-late' },
          });
        }
        return new Promise((resolve) => {
          acknowledge = resolve;
        });
      });
      await expect(
        runner?.execute({ ...runInput(), deadlineMs: 50 }, commit),
      ).rejects.toThrow('commit outcome is uncertain');
      if (!acknowledge) throw new Error('Commit never started.');
      const acceptLate = async () => {
        acknowledge!({ status: 'proven', evaluationId: 'evaluation-late' });
        await new Promise((resolve) => setTimeout(resolve, 10));
      };
      if (timing === 'before') await acceptLate();
      else if (timing === 'during') onRead = acceptLate;
      else onSubmission = acceptLate;
      expect(task.status).toBe('waiting_external');
      await expect(
        runner?.execute({ ...runInput(), deadlineMs: 200 }, commit),
      ).resolves.toEqual({
        status: 'proven',
        evaluationId: 'evaluation-late',
      });
      expect(commit).toHaveBeenCalledOnce();
    },
  );
  it('does not start an HTTP request after the absolute deadline', async () => {
    await expect(
      fetchForValidation({
        request: { url: 'https://tenders.example.test/api', method: 'GET' },
        allowedOrigins: new Set(['https://tenders.example.test']),
        deadlineAtMs: Date.now() - 1,
        maxResponseBytes: 1024,
      }),
    ).rejects.toThrow('deadline');
    expect(mocks.resolvePublicEgressAddress).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'changed fence'])(
    'rejects a late result after %s',
    async (change) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-hosted-'),
      );
      temporaryDirectories.push(directory);
      const modulePath = path.join(directory, 'runner.mjs');
      const source = `export async function execute() { return { status: 'proven' }; }`;
      fs.writeFileSync(modulePath, source);
      const getTask = vi
        .fn()
        .mockResolvedValueOnce(validationTask())
        .mockResolvedValue({
          ...validationTask(),
          ...(change === 'cancelled'
            ? { status: 'cancelled' }
            : { fencingVersion: 999 }),
        });
      const commitResult = vi.fn();
      const runner = createConfiguredGantryHostedCapabilityRunner({
        env: JSON.stringify([
          {
            capabilityId: 'manipal.website-recipe-evaluator@13',
            operation: 'validate_recipe',
            modulePath,
            sha256: createHash('sha256').update(source).digest('hex'),
            resultCommitOperation: 'validation_commit',
          },
        ]),
        getFileArtifactStore: () => undefined,
        getAsyncTaskRepository: () => ({ getTask }) as never,
        openBrowserSession: vi.fn(),
      });
      await expect(runner?.execute(runInput(), commitResult)).rejects.toThrow(
        change === 'cancelled' ? 'cancelled' : 'lease changed',
      );
      expect(commitResult).not.toHaveBeenCalled();
    },
  );

  it('connects direct HTTP validation to the exact vetted DNS address', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test HTTP server did not expose a TCP address.');
    }
    mocks.resolvePublicEgressAddress.mockResolvedValue({
      ok: true,
      host: 'tenders.example.test',
      address: '127.0.0.1',
      family: 4,
    });
    try {
      await expect(
        fetchForValidation({
          request: {
            url: `http://tenders.example.test:${address.port}/api`,
            method: 'GET',
          },
          allowedOrigins: new Set([
            `http://tenders.example.test:${address.port}`,
          ]),
          deadlineAtMs: Date.now() + 5_000,
          maxResponseBytes: 1_024,
        }),
      ).resolves.toMatchObject({
        status: 200,
        bodyBase64: Buffer.from('{"ok":true}').toString('base64'),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('strips all caller headers on an approved cross-origin redirect', async () => {
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const server = http.createServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, {
          location: `http://other.example.test:${(server.address() as import('node:net').AddressInfo).port}/end`,
        });
      } else {
        receivedHeaders = request.headers;
        response.writeHead(200);
      }
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as import('node:net').AddressInfo).port;
    mocks.resolvePublicEgressAddress.mockResolvedValue({
      ok: true,
      address: '127.0.0.1',
      family: 4,
    });
    try {
      await fetchForValidation({
        request: {
          url: `http://tenders.example.test:${port}/start`,
          method: 'GET',
          headers: {
            Authorization: 'Bearer test-only',
            Cookie: 'session=test-only',
            'X-API-Key': 'test-only',
          },
        },
        allowedOrigins: new Set([
          `http://tenders.example.test:${port}`,
          `http://other.example.test:${port}`,
        ]),
        deadlineAtMs: Date.now() + 5000,
        maxResponseBytes: 1024,
      });
      expect(receivedHeaders).not.toHaveProperty('authorization');
      expect(receivedHeaders).not.toHaveProperty('cookie');
      expect(receivedHeaders).not.toHaveProperty('x-api-key');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('bounds a hanging module by the absolute execution deadline', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute() { return await new Promise(() => {}); }`;
    fs.writeFileSync(modulePath, source);
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256: createHash('sha256').update(source).digest('hex'),
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({ getTask: vi.fn(async () => validationTask()) }) as never,
      openBrowserSession: vi.fn(),
    });
    await expect(
      runner?.execute({ ...runInput(), deadlineMs: 25 }),
    ).rejects.toThrow('deadline');
  });

  it('bounds and cleans up a stalled browser startup by the capability-owned operation deadline', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute(_input, host) {
      return host.withBrowserSession(async () => ({}), { deadlineAtMs: Date.now() + 25 });
    }`;
    fs.writeFileSync(modulePath, source);
    const closeBrowserSession = vi.fn(async () => undefined);
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: runInput().capabilityId,
          operation: 'validate_recipe',
          modulePath,
          sha256: createHash('sha256').update(source).digest('hex'),
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({ getTask: async () => validationTask() }) as never,
      openBrowserSession: vi.fn(async () => await new Promise<never>(() => {})),
      closeBrowserSession,
    });
    const startedAt = Date.now();
    await expect(
      runner?.execute({ ...runInput(), deadlineMs: 1000 }),
    ).rejects.toThrow('deadline');
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(closeBrowserSession).toHaveBeenCalledTimes(1);
  });

  it('exposes only the admission-bound completed predecessor result', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute(_input, host) {
      return await host.readPreviousCapabilityResult();
    }`;
    fs.writeFileSync(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const previousResult = {
      status: 'revision_required',
      failureSignature: `sha256:${'f'.repeat(64)}`,
    };
    const previousTask = {
      ...validationTask('task-previous'),
      status: 'completed',
      authoritySnapshotJson: {
        capabilityId: 'manipal.website-recipe-evaluator@13',
        operation: 'validate_recipe',
        contentDigest: `sha256:${'a'.repeat(64)}`,
      },
      privateCorrelationJson: {
        result: previousResult,
        completionTokenHash: 'must-not-be-exposed',
      },
    } as const;
    const currentTask = {
      ...validationTask(),
      authoritySnapshotJson: {
        capabilityId: 'manipal.website-recipe-evaluator@13',
        operation: 'validate_recipe',
        contentDigest: `sha256:${'c'.repeat(64)}`,
      },
      privateCorrelationJson: {
        previousCapabilityTaskId: previousTask.id,
      },
    } as const;
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256,
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({
          getTask: vi.fn(async (taskId: string) =>
            taskId === previousTask.id ? previousTask : currentTask,
          ),
        }) as never,
      openBrowserSession: vi.fn(),
    });

    const result = await runner?.execute(runInput());

    expect(result).toEqual({
      taskId: previousTask.id,
      contentDigest: previousTask.authoritySnapshotJson.contentDigest,
      resultHash: `sha256:${stableSha256Json(previousResult)}`,
      result: previousResult,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-exposed');
  });

  it('returns null when admission did not bind a predecessor', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute(_input, host) {
      return { previous: await host.readPreviousCapabilityResult() };
    }`;
    fs.writeFileSync(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256,
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({ getTask: vi.fn(async () => validationTask()) }) as never,
      openBrowserSession: vi.fn(),
    });

    await expect(runner?.execute(runInput())).resolves.toEqual({
      previous: null,
    });
  });

  it('rejects a capability task whose admitted authority does not match the runner input', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute() { return {}; }`;
    fs.writeFileSync(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const mismatched = {
      ...validationTask(),
      authoritySnapshotJson: {
        capabilityId: 'manipal.website-recipe-evaluator@12',
        operation: 'validate_recipe',
      },
    };
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256,
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({ getTask: vi.fn(async () => mismatched) }) as never,
      openBrowserSession: vi.fn(),
    });

    await expect(runner?.execute(runInput())).rejects.toThrow(
      /task identity is invalid/iu,
    );
  });

  it.each([
    ['job', { parentJobId: 'job-other' }],
    ['agent', { agentId: 'agent:other' }],
    [
      'capability',
      {
        authoritySnapshotJson: {
          capabilityId: 'manipal.website-recipe-evaluator@12',
          operation: 'validate_recipe',
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
      },
    ],
    [
      'operation',
      {
        authoritySnapshotJson: {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'recipe_compile',
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
      },
    ],
    ['status', { status: 'waiting_external' }],
  ] as const)(
    'fails closed when the predecessor %s does not match',
    async (_field, mismatch) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-hosted-'),
      );
      temporaryDirectories.push(directory);
      const modulePath = path.join(directory, 'runner.mjs');
      const source = `export async function execute(_input, host) {
        return await host.readPreviousCapabilityResult();
      }`;
      fs.writeFileSync(modulePath, source);
      const sha256 = createHash('sha256').update(source).digest('hex');
      const previousTask = {
        ...validationTask('task-previous'),
        status: 'completed',
        authoritySnapshotJson: {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
        privateCorrelationJson: { result: { status: 'revision_required' } },
        ...mismatch,
      };
      const currentTask = {
        ...validationTask(),
        privateCorrelationJson: {
          previousCapabilityTaskId: previousTask.id,
        },
      };
      const runner = createConfiguredGantryHostedCapabilityRunner({
        env: JSON.stringify([
          {
            capabilityId: 'manipal.website-recipe-evaluator@13',
            operation: 'validate_recipe',
            modulePath,
            sha256,
          },
        ]),
        getFileArtifactStore: () => undefined,
        getAsyncTaskRepository: () =>
          ({
            getTask: vi.fn(async (taskId: string) =>
              taskId === previousTask.id ? previousTask : currentTask,
            ),
          }) as never,
        openBrowserSession: vi.fn(),
      });

      await expect(runner?.execute(runInput())).rejects.toThrow(
        /predecessor/iu,
      );
    },
  );

  it('isolates and closes browser profiles between validation tasks', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute(_input, host) {
      return host.withBrowserSession(async () => ({ status: 'proven' }));
    }`;
    fs.writeFileSync(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    mocks.withIsolatedValidationBrowserSession.mockImplementation(
      async ({ execute }) =>
        execute({
          page: 'fresh-page',
          context: { browser: () => ({ version: () => 'Chromium 152' }) },
        }),
    );
    const openBrowserSession = vi.fn(async (profileName: string) => ({
      profile: profileName,
      profileName,
      running: true,
      cdpReady: true,
      port: 9222,
    }));
    const closeBrowserSession = vi.fn(async () => ({ closed: true }));
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256,
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({
          getTask: vi.fn(async (taskId: string) => validationTask(taskId)),
        }) as never,
      openBrowserSession,
      closeBrowserSession,
    });

    await runner?.execute(runInput('task-a'));
    await runner?.execute(runInput('task-b'));

    const firstProfile = openBrowserSession.mock.calls[0]?.[0];
    const secondProfile = openBrowserSession.mock.calls[1]?.[0];
    expect(firstProfile).toMatch(/^hosted-validation-[a-f0-9]{16}$/u);
    expect(secondProfile).toMatch(/^hosted-validation-[a-f0-9]{16}$/u);
    expect(firstProfile).not.toBe(secondProfile);
    expect(closeBrowserSession.mock.calls).toEqual([
      [firstProfile],
      [secondProfile],
    ]);
  });

  it('verifies the module digest and exposes only same-job artifacts and fresh browser sessions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute(input, host) {
      const artifact = await host.readJsonArtifact(input.arguments.candidateArtifactId);
      await host.saveValidationCase({ caseId: 'listing', result: { status: 'passed' } });
      await host.saveValidationCase({ caseId: 'listing', result: { status: 'passed' } });
      const checkpoint = await host.readValidationCheckpoint();
      await host.throwIfCancelled();
      return host.withBrowserSession(async ({ page }) => ({ status: 'proven', artifact, page, checkpoint }));
    }`;
    fs.writeFileSync(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    mocks.withIsolatedValidationBrowserSession.mockImplementation(
      async ({ execute }) =>
        execute({
          page: 'fresh-page',
          context: {
            browser: () => ({ version: () => 'Chromium 152.0.7977.82' }),
          },
        }),
    );
    const readFileArtifact = vi.fn(async () => ({
      artifact: {
        virtualScope: jobArtifactScope('job-1'),
        contentHash: 'sha256:candidate',
      },
      content: JSON.stringify({ recipe: { version: 2 } }),
    }));
    let task = validationTask();
    const getTask = vi.fn(async () => task);
    const transitionTask = vi.fn(async (input) => {
      task = {
        ...task,
        status: input.status,
        privateCorrelationJson: input.privateCorrelationJson,
        updatedAt: '2026-09-10T00:00:01.000Z',
      };
      return task;
    });
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256,
        },
      ]),
      getFileArtifactStore: () => ({ readFileArtifact }) as never,
      getAsyncTaskRepository: () => ({ getTask, transitionTask }) as never,
      openBrowserSession: vi.fn(async () => ({
        profile: 'validation',
        profileName: 'validation',
        running: true,
        cdpReady: true,
        port: 9222,
      })),
    });

    await expect(runner?.execute(runInput())).resolves.toMatchObject({
      status: 'proven',
      artifact: {
        contentHash: 'sha256:candidate',
        value: { recipe: { version: 2 } },
      },
      page: 'fresh-page',
      checkpoint: {
        completedCases: { listing: { status: 'passed' } },
      },
    });
    expect(transitionTask).toHaveBeenCalledTimes(1);
    expect(mocks.withIsolatedValidationBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedOrigins: ['https://tenders.example.gov'],
        port: 9222,
      }),
    );
  });

  it('fails closed when the installed module digest changes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    fs.writeFileSync(modulePath, 'export async function execute() {}');
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256: '0'.repeat(64),
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({ getTask: vi.fn(async () => validationTask()) }) as never,
      openBrowserSession: vi.fn(),
    });

    await expect(runner?.execute(runInput())).rejects.toThrow(
      'digest mismatch',
    );
  });

  it('commits through the trusted host callback without exposing credentials to the module', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute(input) {
      return { status: 'needs_review', sawCompletionToken: 'capabilityTaskCompletionToken' in input };
    }`;
    fs.writeFileSync(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const commitResult = vi.fn(async (_operation, payload) => ({
      status: 'proven',
      evaluationId: 'evaluation-1',
      payload,
    }));
    let commitTask = validationTask();
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256,
          resultCommitOperation: 'validation_commit',
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({
          getTask: vi.fn(async () => commitTask),
          transitionTask: async (input: {
            privateCorrelationJson: Record<string, unknown>;
          }) => {
            commitTask = {
              ...commitTask,
              privateCorrelationJson: input.privateCorrelationJson,
            };
            return commitTask;
          },
        }) as never,
      openBrowserSession: vi.fn(),
    });

    await expect(
      runner?.execute(runInput(), commitResult),
    ).resolves.toMatchObject({
      status: 'proven',
      evaluationId: 'evaluation-1',
      payload: {
        runnerAttestation: { sha256: `sha256:${sha256}` },
        result: { status: 'needs_review', sawCompletionToken: false },
      },
    });
    expect(commitResult).toHaveBeenCalledWith(
      'validation_commit',
      expect.objectContaining({ taskIdentity: 'task-1' }),
    );
  });

  it('resumes from completed case checkpoints after an interrupted run', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute(_input, host) {
      const checkpoint = await host.readValidationCheckpoint();
      if (!checkpoint.completedCases.listing) {
        await host.saveValidationCase({ caseId: 'listing', result: { status: 'passed' } });
        throw new Error('simulated interruption');
      }
      return { status: 'needs_review', completedCases: checkpoint.completedCases };
    }`;
    fs.writeFileSync(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    let task = validationTask();
    const transitionTask = vi.fn(async (input) => {
      task = {
        ...task,
        privateCorrelationJson: input.privateCorrelationJson,
        updatedAt: '2026-09-10T00:00:01.000Z',
      };
      return task;
    });
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256,
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () =>
        ({
          getTask: vi.fn(async () => task),
          transitionTask,
        }) as never,
      openBrowserSession: vi.fn(),
    });

    await expect(runner?.execute(runInput())).rejects.toThrow(
      'simulated interruption',
    );
    await expect(runner?.execute(runInput())).resolves.toEqual({
      status: 'needs_review',
      completedCases: { listing: { status: 'passed' } },
    });
    expect(transitionTask).toHaveBeenCalledOnce();
  });

  it('stops when the durable task lease changes during validation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-hosted-'));
    temporaryDirectories.push(directory);
    const modulePath = path.join(directory, 'runner.mjs');
    const source = `export async function execute(_input, host) {
      await host.readValidationCheckpoint();
      await host.throwIfCancelled();
      return { status: 'needs_review' };
    }`;
    fs.writeFileSync(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const original = validationTask();
    const changed = {
      ...original,
      leaseToken: 'lease-2',
      fencingVersion: 2,
    };
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
    const runner = createConfiguredGantryHostedCapabilityRunner({
      env: JSON.stringify([
        {
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          modulePath,
          sha256,
        },
      ]),
      getFileArtifactStore: () => undefined,
      getAsyncTaskRepository: () => ({ getTask }) as never,
      openBrowserSession: vi.fn(),
    });

    await expect(runner?.execute(runInput())).rejects.toThrow(
      'task lease changed',
    );
  });
});

function runInput(taskId = 'task-1') {
  return {
    appId: 'app:test',
    agentId: 'agent:test',
    conversationId: 'sl:C123',
    threadId: null,
    jobId: 'job-1',
    runId: 'run-1',
    capabilityId: 'manipal.website-recipe-evaluator@13',
    operation: 'validate_recipe',
    arguments: {
      candidateArtifactId: 'file-artifact:11111111-1111-4111-8111-111111111111',
    },
    runtimeContext: {
      allowedOrigins: ['https://tenders.example.gov'],
      capabilityTaskIdentity: { taskId },
    },
    deadlineMs: 10_000,
  };
}

function validationTask(id = 'task-1') {
  return {
    id,
    appId: 'app:test',
    agentId: 'agent:test',
    parentJobId: 'job-1',
    kind: 'external_capability',
    status: 'waiting_external',
    authoritySnapshotJson: {
      capabilityId: 'manipal.website-recipe-evaluator@13',
      operation: 'validate_recipe',
      contentDigest: `sha256:${'c'.repeat(64)}`,
    },
    leaseToken: 'lease-1',
    fencingVersion: 1,
    updatedAt: '2026-09-10T00:00:00.000Z',
    privateCorrelationJson: {},
  } as const;
}
