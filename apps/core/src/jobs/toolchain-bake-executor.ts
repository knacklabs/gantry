import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  RuntimeDependency,
  RuntimeDependencyRepository,
} from '../domain/ports/fleet-capability-state.js';
import type {
  ToolchainArtifactFile,
  ToolchainArtifactStore,
} from '../domain/ports/toolchain-artifact-store.js';
import {
  NATIVE_MODULE_SCRIPT_ALLOWLIST,
  renderBakeNpmrc,
  renderBakePackageJson,
} from './toolchain-bake-manifest.js';
import type { ToolchainCommandRunner } from './toolchain-bake-runner.js';

export interface ToolchainBakeNotifier {
  /** pg_notify the manifest channel so worker reconcilers wake on completion. */
  notifyManifestChanged(input: {
    appId: string;
    manifestHash: string;
    status: RuntimeDependency['status'];
  }): Promise<void>;
}

/**
 * Outcome notices to the approval conversation that requested the dependency.
 * Both are one concise message, best-effort at the call site (delivery reuses
 * the channel machinery; the executor only formats and triggers them) — a
 * notice failure never fails the bake.
 */
export interface ToolchainBakeOutcomeNotice {
  /** Bake uploaded: the toolchain is rolling out to workers. */
  sendSuccessNotice(input: { dependency: RuntimeDependency }): Promise<void>;
  /** Bake failed: include the concise reason. */
  sendFailureNotice(input: {
    dependency: RuntimeDependency;
    reason: string;
  }): Promise<void>;
}

export interface ToolchainBakeExecutorDeps {
  runtimeDependencies: RuntimeDependencyRepository;
  toolchainStore: ToolchainArtifactStore;
  commandRunner: ToolchainCommandRunner;
  notifier: ToolchainBakeNotifier;
  outcomeNotice: ToolchainBakeOutcomeNotice;
  registry: string;
  logWarn?: (context: Record<string, unknown>, message: string) => void;
  /** Override the npm binary/argv prefix for tests. Defaults to `npm`. */
  npmCommand?: string;
  installTimeoutMs?: number;
}

export type ToolchainBakeOutcome =
  | { result: 'uploaded'; manifestHash: string }
  | { result: 'skipped'; reason: 'not_claimable' }
  | { result: 'failed'; reason: string };

export const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Execute a single toolchain bake for a runtime_dependencies row. Lifecycle:
 * claim queued→baking (status CAS = the bake's lease), run lockfile-pinned
 * `npm install --ignore-scripts` in a temp dir against the allowlisted
 * registry, pack node_modules + lockfile + package.json, upload via the
 * artifact store, then transition baking→uploaded with the artifact ref + hash
 * and NOTIFY. Either terminal outcome sends one concise best-effort notice to
 * the approval conversation: success ("baked and rolling out") on uploaded,
 * the failure reason on →failed. Idempotent: a row that is not `queued`
 * (another worker already claimed/completed it) short-circuits.
 *
 * Crash/drain recovery: a hard death (SIGKILL/OOM) or a rolling-deploy drain
 * mid-install strands the row at `baking` — drain deliberately does NOT await
 * the in-flight install (the default drain deadline is shorter than the install
 * timeout, so waiting could not guarantee completion anyway; see
 * `ToolchainBakeQueue.stop`). The `ToolchainBakeReaper` recovers it: rows whose
 * `updated_at` is older than `bakeReapStalenessMs()` (≥ 2× the install timeout
 * plus an upload allowance) are CAS-reset baking→queued and re-enqueued.
 *
 * Double-bake tolerance: a slow-but-alive baker can exceed the reap threshold,
 * lose its row to the reaper, and race a second baker for the same manifest.
 * Both terminal CAS writes here guard on fromStatus 'baking', and a lost CAS is
 * a benign no-op (outcome `skipped`, no NOTIFY, no user notice) — exactly one
 * baker's terminal write lands. The generous reap threshold makes this race
 * rare; if the loser's S3 upload still overwrote the winner's bytes, the worker
 * reconciler's sha256 verify quarantines the mismatch and
 * `gantry artifacts quarantine rebake` re-bakes it.
 */
export async function executeToolchainBake(
  deps: ToolchainBakeExecutorDeps,
  input: { dependencyId: string },
): Promise<ToolchainBakeOutcome> {
  const dependency = await deps.runtimeDependencies.getRuntimeDependency(
    input.dependencyId,
  );
  if (!dependency) {
    return { result: 'skipped', reason: 'not_claimable' };
  }
  // Claim: only the worker that flips queued→baking owns the bake. Already
  // baking/uploaded/activated/failed rows are owned elsewhere or terminal.
  const claimed = await deps.runtimeDependencies.updateRuntimeDependencyStatus({
    id: dependency.id,
    status: 'baking',
    fromStatus: 'queued',
  });
  if (!claimed) {
    return { result: 'skipped', reason: 'not_claimable' };
  }
  await deps.notifier.notifyManifestChanged({
    appId: dependency.appId,
    manifestHash: dependency.manifestHash,
    status: 'baking',
  });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-bake-'));
  try {
    await writeBakeInputs(workDir, dependency.requestedPackages, deps.registry);
    await runNpmInstall(deps, dependency, workDir);
    const files = await packToolchain(workDir);
    const stored = await deps.toolchainStore.putToolchainArtifact({
      appId: dependency.appId,
      manifestHash: dependency.manifestHash,
      files,
    });
    const uploaded =
      await deps.runtimeDependencies.updateRuntimeDependencyStatus({
        id: dependency.id,
        status: 'uploaded',
        fromStatus: 'baking',
        artifact: {
          storageType: stored.storageType,
          storageRef: stored.storageRef,
          contentHash: stored.contentHash,
          sizeBytes: stored.sizeBytes,
        },
      });
    if (!uploaded) {
      // Lost the lease (row recovered/superseded); drop our write.
      return { result: 'skipped', reason: 'not_claimable' };
    }
    await deps.notifier.notifyManifestChanged({
      appId: dependency.appId,
      manifestHash: dependency.manifestHash,
      status: 'uploaded',
    });
    try {
      await deps.outcomeNotice.sendSuccessNotice({ dependency });
    } catch (noticeErr) {
      deps.logWarn?.(
        { err: noticeErr, dependencyId: dependency.id },
        'Failed to deliver toolchain bake success notice',
      );
    }
    return { result: 'uploaded', manifestHash: dependency.manifestHash };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'toolchain bake failed';
    const failed = await deps.runtimeDependencies.updateRuntimeDependencyStatus(
      {
        id: dependency.id,
        status: 'failed',
        fromStatus: 'baking',
        failureReason: reason,
      },
    );
    if (!failed) {
      // Lost the lease (row reaped/superseded mid-bake): benign no-op. The
      // current owner reports the real outcome; no NOTIFY, no user notice.
      deps.logWarn?.(
        { dependencyId: dependency.id, reason },
        'Toolchain bake lost its row before the failed write; dropping outcome',
      );
      return { result: 'skipped', reason: 'not_claimable' };
    }
    await deps.notifier.notifyManifestChanged({
      appId: dependency.appId,
      manifestHash: dependency.manifestHash,
      status: 'failed',
    });
    try {
      await deps.outcomeNotice.sendFailureNotice({ dependency, reason });
    } catch (noticeErr) {
      deps.logWarn?.(
        { err: noticeErr, dependencyId: dependency.id },
        'Failed to deliver toolchain bake failure notice',
      );
    }
    return { result: 'failed', reason };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function writeBakeInputs(
  workDir: string,
  packages: string[],
  registry: string,
): Promise<void> {
  await fs.writeFile(
    path.join(workDir, 'package.json'),
    renderBakePackageJson(packages),
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(workDir, '.npmrc'), renderBakeNpmrc(registry), {
    mode: 0o600,
  });
}

async function runNpmInstall(
  deps: ToolchainBakeExecutorDeps,
  dependency: RuntimeDependency,
  workDir: string,
): Promise<void> {
  const npm = deps.npmCommand ?? 'npm';
  const argv = [
    npm,
    'install',
    '--package-lock-only=false',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
  ];
  const result = await deps.commandRunner.run({
    argv,
    cwd: workDir,
    env: bakeEnv(),
    timeoutMs: deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `npm install failed (exit ${result.exitCode}) for ${dependency.requestedPackages.join(
        ', ',
      )}: ${tail(result.stderr || result.stdout)}`,
    );
  }
  // Native-module allowlist is empty by default; when populated a reviewed
  // re-enable step would run here for allowlisted packages only. Documented as
  // a code-reviewed constant per ADR capability-artifacts.
  void NATIVE_MODULE_SCRIPT_ALLOWLIST;
}

async function packToolchain(
  workDir: string,
): Promise<ToolchainArtifactFile[]> {
  const files: ToolchainArtifactFile[] = [];
  for (const relative of ['package.json', 'package-lock.json', '.npmrc']) {
    const filePath = path.join(workDir, relative);
    const content = await readOptional(filePath);
    if (content) files.push({ path: relative, content });
  }
  await collectDir(workDir, path.join(workDir, 'node_modules'), files);
  return files;
}

async function collectDir(
  root: string,
  dir: string,
  out: ToolchainArtifactFile[],
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.readlink(full);
      out.push({
        path: relative,
        kind: 'symlink',
        linkTarget,
        content: Buffer.alloc(0),
      });
      continue;
    }
    if (entry.isDirectory()) {
      await collectDir(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(full);
    out.push({
      path: relative,
      kind: 'file',
      mode: stat.mode & 0o777,
      content: await fs.readFile(full),
    });
  }
}

async function readOptional(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

function bakeEnv(): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = { npm_config_audit: 'false' };
  for (const key of allow) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

function tail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `…${trimmed.slice(-500)}` : trimmed;
}
