import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engine } from './docker-engine-client.mjs';
export { engine } from './docker-engine-client.mjs';
import { candidateFor, publicEvidence, validateDisposable } from './f2-container-policy.mjs';

export const requiredChecks = ['startup', 'settingsImport', 'workspace', 'httpsProxy', 'cdp', 'discovery', 'streamedCompletion'];

/** A first comparison never establishes full F2 acceptance. */
export function classifyProbe(report, stage = 'privileged-off') {
  const values = Object.values(report.checks ?? {});
  const status = values.includes(false) ? 'failed'
    : values.includes('blocked') ? 'blocked'
      : requiredChecks.every(k => report.checks?.[k] === true) && report.jobId && report.runId
        ? (stage === 'privileged-off' ? 'working-first-comparison' : 'working-candidate') : 'partial';
  return { status, f2Accepted: false, missing: requiredChecks.filter(k => report.checks?.[k] !== true) };
}

function docker(args, timeout = 10_000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4e6 });
  if (result.status !== 0) throw new Error('Docker operation failed; private evidence contains the command result');
  return result.stdout.trim();
}

/** Start only an explicitly disposable candidate; never start Compose or existing services. */
export async function runComparison() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const output = path.join(root, '.local/f2-execution/minimum-host-access', randomUUID());
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(output, '.gitignore'), '*\n', { mode: 0o600 });
  const result = { at: new Date().toISOString(), status: 'blocked', f2Accepted: false };
  let id; let socket; let candidate;
  const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    const available = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 10_000 });
    save('docker-availability.private.json', { code: available.status, error: available.error?.code, stderr: available.stderr });
    if (available.status !== 0) {
      result.reason = 'docker_unavailable';
      return result;
    }
    result.dockerVersion = available.stdout.trim();
    const specFile = process.env.F2_CREATE_SPEC_FILE;
    const probeFile = process.env.F2_ACCEPTANCE_PROBE;
    if (!specFile || !probeFile) {
      result.reason = 'disposable_spec_or_real_job_probe_missing';
      return result;
    }
    const source = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    validateDisposable(source);
    const stage = process.env.F2_STAGE || 'privileged-off';
    const options = process.env.F2_STAGE_OPTIONS_FILE
      ? JSON.parse(fs.readFileSync(process.env.F2_STAGE_OPTIONS_FILE, 'utf8')) : {};
    candidate = candidateFor(source, stage, options);
    validateDisposable(candidate);
    assert.equal(candidate.HostConfig.Privileged, false);
    const context = JSON.parse(docker(['context', 'inspect']));
    const host = process.env.DOCKER_HOST || context[0].Endpoints.docker.Host;
    assert.ok(host.startsWith('unix://'), 'Use the local Docker engine only');
    socket = host.slice('unix://'.length);
    const net = await engine(socket, 'GET', `/networks/${encodeURIComponent(candidate.HostConfig.NetworkMode)}`);
    assert.equal(net.Labels?.['gantry.f2.disposable'], 'true', 'Use a task-owned test network');
    for (const member of Object.keys(net.Containers ?? {})) {
      const peer = await engine(socket, 'GET', `/containers/${member}/json`);
      assert.equal(peer.Config?.Labels?.['gantry.f2.disposable'], 'true', 'Do not share the fixture network with existing services');
    }
    for (const mount of candidate.HostConfig.Mounts ?? []) {
      const volume = await engine(socket, 'GET', `/volumes/${encodeURIComponent(mount.Source)}`);
      assert.equal(volume.Labels?.['gantry.f2.disposable'], 'true', 'Use task-owned test volumes');
    }
    const image = await engine(socket, 'GET', `/images/${encodeURIComponent(candidate.Image)}/json`);
    assert.equal(image.Id, candidate.Image);
    result.stage = stage;
    result.policy = publicEvidence(candidate);
    result.sourceRevision = image.Config?.Labels?.['org.opencontainers.image.revision'] ?? null;
    save('baseline.private.json', source);
    save('candidate.private.json', candidate);
    const created = await engine(socket, 'POST', `/containers/create?name=gantry-f2-${randomUUID()}`, candidate);
    id = created.Id;
    await engine(socket, 'POST', `/containers/${id}/start`);
    const effective = await engine(socket, 'GET', `/containers/${id}/json`);
    save('effective.private.json', effective);
    assert.equal(effective.HostConfig.Privileged, false);
    result.containerId = id;
    const execution = spawnSync(process.execPath, [path.resolve(probeFile)], {
      encoding: 'utf8', timeout: 300_000, maxBuffer: 8e6,
      env: { ...process.env, F2_CONTAINER_ID: id, F2_EVIDENCE_DIR: output },
    });
    save('probe.private.json', { code: execution.status, error: execution.error?.code, stdout: execution.stdout, stderr: execution.stderr });
    if (execution.status !== 0) {
      result.status = execution.status === 2 || execution.error?.code === 'ENOENT' ? 'blocked' : 'failed';
      result.reason = execution.error?.code === 'ETIMEDOUT' ? 'real_job_probe_timeout' : 'real_job_probe_did_not_complete';
      return result;
    }
    const report = JSON.parse(execution.stdout);
    Object.assign(result, classifyProbe(report, stage), { jobId: report.jobId, runId: report.runId });
    return result;
  } catch (error) {
    save('error.private.json', { name: error.name, message: error.message });
    result.status = 'blocked';
    result.reason = 'comparison_setup_or_execution_error';
    return result;
  } finally {
    if (id) {
      const logs = spawnSync('docker', ['logs', '--tail', '500', id], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4e6 });
      save('container-logs.private.json', { stdout: logs.stdout, stderr: logs.stderr });
      const stop = spawnSync('docker', ['stop', '--time', '10', id], { encoding: 'utf8', timeout: 20_000 });
      result.cleanup = stop.status === 0 ? 'candidate-stopped-state-retained' : 'candidate-stop-failed';
      if (stop.status !== 0) { result.status = 'failed'; result.reason = 'candidate_stop_failed'; }
    }
    result.evidenceDirectory = output;
    save('result.json', result);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runComparison();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ['working-first-comparison', 'working-candidate'].includes(result.status) ? 0 : 1;
}
