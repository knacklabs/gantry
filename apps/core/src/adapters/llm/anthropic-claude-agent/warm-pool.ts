import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import {
  writeBoundIdentityFile,
  writeBoundIdentityFilePath,
  type BoundIdentity,
} from '../../../runner/mcp/bound-identity.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  cacheShapeKeyOf,
  type BoundRun,
  type ConversationBindScope,
  type SharedBootRecipe,
  type WarmBindDelivery,
  type WarmWorkerCachePrewarmResult,
  type WarmWorkerHandle,
} from '../../../application/agent-execution/warm-pool-capable.js';
import { OUTPUT_END_MARKER, OUTPUT_START_MARKER } from './runner/output.js';

const READY_MARKER = 'awaiting bind';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_PREWARM_TIMEOUT_MS = 120_000;
const CACHE_PREWARM_PROMPT = 'Reply with exactly PREWARM_OK.';

type SpawnFunction = typeof nodeSpawn;

interface WarmWorkerRecord {
  readonly handle: WarmWorkerHandle;
  readonly recipe: SharedBootRecipe;
  readonly process: ChildProcess;
  readonly cleanup?: () => Promise<void> | void;
}

function boundIdentityFromScope(scope: ConversationBindScope): BoundIdentity {
  return {
    chatJid: scope.chatJid,
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    ...(scope.memoryUserId ? { memoryUserId: scope.memoryUserId } : {}),
    runHandle: scope.runHandle,
    ipcAuthToken: scope.ipcAuthToken,
    ...(scope.browserIpcAuthToken
      ? { browserIpcAuthToken: scope.browserIpcAuthToken }
      : {}),
    memoryIpcAuthToken: scope.memoryIpcAuthToken,
    ipcResponseKeyId: scope.ipcResponseKeyId,
    ipcResponseVerifyKey: scope.ipcResponseVerifyKey,
  };
}

export interface AnthropicWarmPoolOptions {
  spawn?: SpawnFunction;
  cachePrewarmProbe?: (handle: WarmWorkerHandle) => Promise<void>;
  now?: () => number;
  readyTimeoutMs?: number;
  cachePrewarmTimeoutMs?: number;
}

export class AnthropicWarmPoolController {
  private readonly spawn: SpawnFunction;
  private readonly cachePrewarmProbe?: (
    handle: WarmWorkerHandle,
  ) => Promise<void>;
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;
  private readonly cachePrewarmTimeoutMs: number;
  private readonly workers = new Map<string, WarmWorkerRecord>();
  private socketBindDelivery: WarmBindDelivery | undefined;

  constructor(options: AnthropicWarmPoolOptions = {}) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.cachePrewarmProbe = options.cachePrewarmProbe;
    this.now = options.now ?? Date.now;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.cachePrewarmTimeoutMs =
      options.cachePrewarmTimeoutMs ?? DEFAULT_CACHE_PREWARM_TIMEOUT_MS;
  }

  async prewarm(recipe: SharedBootRecipe): Promise<WarmWorkerHandle> {
    const command = recipe.runnerCommand;
    const runnerArgs = recipe.runnerArgs;
    const runnerInput = recipe.runnerInput;
    if (!command || !runnerArgs || !runnerInput) {
      throw new Error(
        'Anthropic warm prewarm requires runnerCommand, runnerArgs, and runnerInput',
      );
    }

    const processName =
      recipe.runnerProcessName ??
      `gantry-warm-pool-${this.now()}-${randomUUID().slice(0, 8)}`;
    const args = [...runnerArgs, `--gantry-warm-pool-worker=${processName}`];
    const env: NodeJS.ProcessEnv = {
      ...recipe.runnerEnv,
      GANTRY_AGENT_RUN_HANDLE: processName,
      GANTRY_WARM_POOL_BOOT: 'generic',
      GANTRY_WARM_POOL_MARKER: 'gantry-warm-pool-worker',
      GANTRY_WARM_POOL_WORKER: '1',
    };
    const process = this.spawn(command, args, {
      cwd: recipe.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const groupFolder =
      typeof runnerInput.groupFolder === 'string'
        ? runnerInput.groupFolder
        : undefined;
    const handle: WarmWorkerHandle = {
      id: processName,
      key: recipe.key,
      cacheShapeKey: cacheShapeKeyOf(recipe),
      bornAt: this.now(),
      processName,
      ...(groupFolder ? { groupFolder } : {}),
      ...(env.GANTRY_IPC_DIR ? { ipcDir: env.GANTRY_IPC_DIR } : {}),
      ...(env.GANTRY_BOUND_IDENTITY_FILE
        ? { boundIdentityFile: env.GANTRY_BOUND_IDENTITY_FILE }
        : {}),
      ...(env.GANTRY_MEMORY_IPC_AUTH_TOKEN
        ? { memoryIpcAuthToken: env.GANTRY_MEMORY_IPC_AUTH_TOKEN }
        : {}),
      bound: false,
    };
    const bootInput = {
      ...runnerInput,
      prompt: '',
      compiledSystemPrompt: recipe.compiledSystemPrompt,
      warmGenericBoot: true,
    };
    this.workers.set(handle.id, {
      handle,
      recipe,
      process,
      cleanup: recipe.cleanup,
    });
    const ready = this.waitForReady(handle, process);
    try {
      process.stdin?.write(JSON.stringify(bootInput));
      process.stdin?.end();
      await ready;
      if (groupFolder && this.socketBindDelivery?.waitUntilReady) {
        const socketReady = await this.socketBindDelivery.waitUntilReady(
          handle,
          { groupFolder },
        );
        if (!socketReady) {
          throw new Error(
            `Warm worker ${handle.id} reached generic boot but did not connect its bind socket`,
          );
        }
      }
      return handle;
    } catch (err) {
      this.workers.delete(handle.id);
      this.terminate(process);
      await recipe.cleanup?.();
      throw err;
    }
  }

  async bind(
    handle: WarmWorkerHandle,
    scope: ConversationBindScope,
  ): Promise<BoundRun> {
    const worker = this.workers.get(handle.id);
    if (!worker) {
      throw new Error(`Warm worker ${handle.id} not found`);
    }
    if (handle.bound) {
      throw new Error(`Warm worker ${handle.id} is already bound`);
    }
    this.writeBoundIdentity(scope);
    const socketDelivered =
      (await this.socketBindDelivery
        ?.deliver(handle, scope)
        .catch(() => false)) ?? false;
    if (!socketDelivered) {
      throw new Error(
        `Warm worker ${handle.id} has no connected socket bind delivery`,
      );
    }
    handle.bound = true;
    return {
      handle,
      process: worker.process,
      runHandle: scope.runHandle,
    };
  }

  async recycle(handle: WarmWorkerHandle): Promise<void> {
    const worker = this.workers.get(handle.id);
    this.workers.delete(handle.id);
    if (!worker) return;
    try {
      this.terminate(worker.process);
    } finally {
      await worker.cleanup?.();
    }
  }

  async prewarmCaches(
    handle: WarmWorkerHandle,
  ): Promise<WarmWorkerCachePrewarmResult> {
    if (!this.cachePrewarmProbe) {
      return this.prewarmProviderCache(handle);
    }
    await this.cachePrewarmProbe?.(handle);
    return { status: 'succeeded' };
  }

  async healthCheck(handle: WarmWorkerHandle): Promise<boolean> {
    const worker = this.workers.get(handle.id);
    const childAlive = Boolean(
      worker && worker.process.exitCode === null && !worker.process.killed,
    );
    if (!childAlive) return false;
    if (handle.groupFolder && this.socketBindDelivery?.waitUntilReady) {
      return this.socketBindDelivery.waitUntilReady(handle, {
        groupFolder: handle.groupFolder,
        timeoutMs: 0,
      });
    }
    return true;
  }

  setWarmBindDelivery(delivery: WarmBindDelivery): void {
    this.socketBindDelivery = delivery;
  }

  private writeBoundIdentity(scope: ConversationBindScope): void {
    const identity = boundIdentityFromScope(scope);
    if (scope.boundIdentityFile) {
      writeBoundIdentityFilePath(scope.boundIdentityFile, identity);
      return;
    }
    writeBoundIdentityFile(scope.ipcDir, identity);
  }

  private waitForReady(
    handle: WarmWorkerHandle,
    process: ChildProcess,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderrTail = '';
      const appendStderr = (chunk: Buffer | string): string => {
        stderrTail = `${stderrTail}${String(chunk)}`;
        if (stderrTail.length > 4_000) {
          stderrTail = stderrTail.slice(-4_000);
        }
        return stderrTail;
      };
      const stderrSuffix = (): string => {
        const trimmed = stderrTail.trim();
        return trimmed ? `; stderr tail: ${trimmed}` : '';
      };
      const cleanup = () => {
        clearTimeout(timer);
        process.stderr?.off('data', onStderr);
        process.off('exit', onExit);
        process.off('error', onError);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          this.workers.delete(handle.id);
          reject(error);
          return;
        }
        resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `Timed out waiting ${this.readyTimeoutMs}ms for warm worker ${handle.id} to become bind-ready${stderrSuffix()}`,
            ),
          ),
        this.readyTimeoutMs,
      );
      const onStderr = (chunk: Buffer | string) => {
        if (appendStderr(chunk).includes(READY_MARKER)) finish();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          new Error(
            `Warm worker ${handle.id} exited before bind-ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})${stderrSuffix()}`,
          ),
        );
      };
      const onError = (error: Error) => {
        finish(error);
      };
      process.stderr?.on('data', onStderr);
      process.once('exit', onExit);
      process.once('error', onError);
    });
  }

  private async prewarmProviderCache(
    handle: WarmWorkerHandle,
  ): Promise<WarmWorkerCachePrewarmResult> {
    const worker = this.workers.get(handle.id);
    if (!worker) return { status: 'skipped', reason: 'worker_not_found' };
    const recipe = worker.recipe;
    const command = recipe.runnerCommand;
    const runnerArgs = recipe.runnerArgs;
    const runnerInput = recipe.runnerInput;
    if (!command || !runnerArgs || !runnerInput) {
      return { status: 'skipped', reason: 'probe_unavailable' };
    }
    const processName = `${handle.id}-cache-prewarm-${randomUUID().slice(0, 8)}`;
    const env: NodeJS.ProcessEnv = {
      ...recipe.runnerEnv,
      GANTRY_AGENT_RUN_HANDLE: processName,
      GANTRY_PROVIDER_CACHE_PREWARM: '1',
      GANTRY_WARM_POOL_BOOT: undefined,
      GANTRY_WARM_POOL_MARKER: undefined,
      GANTRY_WARM_POOL_WORKER: undefined,
    };
    const process = this.spawn(command, [...runnerArgs], {
      cwd: recipe.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const probeInput = {
      ...runnerInput,
      prompt: CACHE_PREWARM_PROMPT,
      compiledSystemPrompt: recipe.compiledSystemPrompt,
      warmGenericBoot: false,
    };
    const output = this.waitForProbeResult(process);
    try {
      process.stdin?.write(JSON.stringify(probeInput));
      process.stdin?.end();
      const result = await output;
      if (result.status === 'succeeded') {
        logger.info(
          {
            workerId: handle.id,
            probeRunHandle: processName,
            cacheShapeKey: handle.cacheShapeKey,
            cacheReadUnits: result.cacheReadTokens ?? 0,
            cacheWriteUnits: result.cacheWriteTokens ?? 0,
          },
          'Provider cache prewarm succeeded',
        );
        return result;
      }
      logger.warn(
        {
          workerId: handle.id,
          probeRunHandle: processName,
          cacheShapeKey: handle.cacheShapeKey,
          reason: result.reason,
        },
        'Provider cache prewarm failed',
      );
      return result;
    } finally {
      this.terminate(process);
    }
  }

  private waitForProbeResult(
    process: ChildProcess,
  ): Promise<WarmWorkerCachePrewarmResult> {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderrTail = '';
      const timer = setTimeout(() => {
        finish({
          status: 'failed',
          reason: `provider cache prewarm timed out after ${this.cachePrewarmTimeoutMs}ms${stderrSuffix()}`,
        });
      }, this.cachePrewarmTimeoutMs);
      const appendStderr = (chunk: Buffer | string): void => {
        stderrTail = `${stderrTail}${String(chunk)}`;
        if (stderrTail.length > 4_000) stderrTail = stderrTail.slice(-4_000);
      };
      const stderrSuffix = (): string => {
        const trimmed = stderrTail.trim();
        return trimmed ? `; stderr tail: ${trimmed}` : '';
      };
      const cleanup = () => {
        clearTimeout(timer);
        process.stdout?.off('data', onStdout);
        process.stderr?.off('data', onStderr);
        process.off('exit', onExit);
        process.off('error', onError);
      };
      const finish = (result: WarmWorkerCachePrewarmResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onStdout = (chunk: Buffer | string) => {
        stdout = `${stdout}${String(chunk)}`;
        const result = this.providerCachePrewarmResultFromOutput(
          stdout,
          () => '',
        );
        if (result.status === 'succeeded') finish(result);
      };
      const onStderr = (chunk: Buffer | string) => appendStderr(chunk);
      const onError = (err: Error) =>
        finish({ status: 'failed', reason: err.message });
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (code !== 0) {
          finish({
            status: 'failed',
            reason: `provider cache prewarm exited with code ${code ?? 'null'} signal ${signal ?? 'null'}${stderrSuffix()}`,
          });
          return;
        }
        finish(this.providerCachePrewarmResultFromOutput(stdout, stderrSuffix));
      };
      process.stdout?.on('data', onStdout);
      process.stderr?.on('data', onStderr);
      process.once('exit', onExit);
      process.once('error', onError);
    });
  }

  private providerCachePrewarmResultFromOutput(
    stdout: string,
    stderrSuffix: () => string,
  ): WarmWorkerCachePrewarmResult {
    for (const output of parseRunnerOutputs(stdout)) {
      if (output.status !== 'success') continue;
      const usage = output.usage;
      const cacheWriteTokens =
        typeof usage?.cacheWriteTokens === 'number'
          ? usage.cacheWriteTokens
          : 0;
      const cacheReadTokens =
        typeof usage?.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
      if (cacheWriteTokens > 0 || cacheReadTokens > 0) {
        return { status: 'succeeded', cacheReadTokens, cacheWriteTokens };
      }
    }
    return {
      status: 'failed',
      reason: `provider cache prewarm completed without cache usage evidence${stderrSuffix()}`,
    };
  }

  private terminate(process: ChildProcess): void {
    if (typeof process.pid === 'number') {
      try {
        globalThis.process.kill(-process.pid, 'SIGTERM');
        return;
      } catch {
        /* fall through to direct child termination */
      }
    }
    process.kill('SIGTERM');
  }
}

function parseRunnerOutputs(stdout: string): Array<{
  status?: string;
  usage?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}> {
  const outputs: Array<{
    status?: string;
    usage?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  }> = [];
  let cursor = 0;
  while (cursor < stdout.length) {
    const start = stdout.indexOf(OUTPUT_START_MARKER, cursor);
    if (start < 0) break;
    const payloadStart = start + OUTPUT_START_MARKER.length;
    const end = stdout.indexOf(OUTPUT_END_MARKER, payloadStart);
    if (end < 0) break;
    const payload = stdout.slice(payloadStart, end).trim();
    try {
      outputs.push(JSON.parse(payload));
    } catch {
      // Ignore malformed runner output; the caller will fail if no valid usage
      // envelope is found.
    }
    cursor = end + OUTPUT_END_MARKER.length;
  }
  return outputs;
}
