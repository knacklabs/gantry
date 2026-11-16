import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { engine } from './docker-engine-client.mjs';

// Compose cannot express these Engine creation fields. Prepare one explicitly
// opted-in, stopped Gantry service; Compose remains responsible for starting it.
export function scopedContainerSpec(inspect, policy) {
  assert.equal(inspect.State.Running, false, 'Stop Gantry explicitly before preparing its process policy');
  assert.equal(inspect.Config.Labels?.['gantry.security.proc-policy'], 'scoped-v1', 'Require explicit deployment opt-in');
  assert.equal(inspect.Config.Labels?.['com.docker.compose.service'], 'gantry-runtime', 'Only prepare the Gantry service');
  assert.ok(['node', 'node:node', '1000', '1000:1000'].includes(inspect.Config.User), 'Require a non-root Gantry image');
  assert.match(inspect.Config.Image, /^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/, 'Pin the reviewed Gantry image by digest');
  const host = structuredClone(inspect.HostConfig);
  assert.equal(host.Privileged, false, 'Privileged mode must already be disabled');
  assert.equal(host.ReadonlyRootfs, true, 'Application filesystem must already be read-only');
  assert.equal((host.CapAdd ?? []).length, 0, 'Do not add outer capabilities');
  assert.deepEqual(host.CapDrop, ['ALL'], 'Drop all outer capabilities');
  assert.ok(host.SecurityOpt?.some(s => /^no-new-privileges[=:]true$/.test(s)), 'Retain no-new-privileges');
  const seccomp = host.SecurityOpt.find(s => s.startsWith('seccomp='));
  assert.ok(seccomp && JSON.parse(seccomp.slice(8)).defaultAction === 'SCMP_ACT_ERRNO', 'Require a filtered seccomp profile');
  assert.ok(!host.SecurityOpt.includes('systempaths=unconfined'), 'Do not blanket-unmask process paths');
  assert.notEqual(host.NetworkMode, 'host', 'Do not share host networking');
  for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'CgroupnsMode']) {
    assert.ok(!host[key] || host[key] === 'private', `Do not share ${key}`);
  }
  for (const key of ['Devices', 'DeviceRequests', 'DeviceCgroupRules', 'VolumesFrom', 'Links']) {
    assert.equal((host[key] ?? []).length, 0, `Do not expose ${key}`);
  }
  for (const mount of inspect.Mounts ?? []) {
    assert.notEqual(mount.Source, '/', 'Do not mount the host root');
    assert.ok(!/(^|\/)docker\.sock$/.test(mount.Source), 'Do not mount the Docker socket');
    assert.ok(!mount.RW || (mount.Type === 'volume' && mount.Destination === '/var/lib/gantry'), 'Only Gantry state may be a writable mount');
  }
  assert.equal(host.AutoRemove, false, 'Retain stopped deployment state');
  for (const [key, values] of [['MaskedPaths', policy.maskedPaths], ['ReadonlyPaths', policy.readonlyPaths]]) {
    assert.ok(Array.isArray(values) && Array.isArray(host[key]), 'Use explicit process-path arrays');
    assert.ok(values.every(p => host[key].includes(p)), 'Do not invent process-path settings');
    const removed = host[key].filter(p => !values.includes(p));
    const permitted = key === 'MaskedPaths'
      ? ['/proc/interrupts', '/proc/kcore', '/proc/keys', '/proc/scsi', '/proc/timer_list']
      : ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'];
    assert.ok(removed.every(p => permitted.includes(p)), 'Remove only the demonstrated process-path conflicts');
    host[key] = [...values];
  }
  assert.ok(host.MaskedPaths.length > 0, 'Do not blanket-unmask process paths');
  const endpoints = {};
  for (const [name, endpoint] of Object.entries(inspect.NetworkSettings.Networks)) {
    assert.ok(!endpoint.IPAMConfig, 'Static network allocation requires an explicit deployment implementation');
    endpoints[name] = { Aliases: endpoint.Aliases ?? [] };
  }
  return { ...structuredClone(inspect.Config), Image: inspect.Image, HostConfig: host, NetworkingConfig: { EndpointsConfig: endpoints } };
}

export async function replaceStoppedContainer(api, id, policy, saveOriginal = () => {}) {
  const original = await api('GET', `/containers/${encodeURIComponent(id)}/json`);
  const specification = scopedContainerSpec(original, policy);
  await saveOriginal(original);
  const name = original.Name.replace(/^\//, '');
  let created; let removedOriginal = false;
  try {
    created = await api('POST', `/containers/create?name=${encodeURIComponent(`${name}-policy-${randomUUID()}`)}`, specification);
    const effective = await api('GET', `/containers/${created.Id}/json`);
    assert.deepEqual(effective.HostConfig.MaskedPaths, policy.maskedPaths, 'Engine did not retain the requested masks');
    assert.deepEqual(effective.HostConfig.ReadonlyPaths, policy.readonlyPaths, 'Engine did not retain the requested read-only paths');
    scopedContainerSpec(effective, policy);
    // No force flag: a concurrent start refuses deletion rather than stopping it.
    await api('DELETE', `/containers/${original.Id}`);
    removedOriginal = true;
    await api('POST', `/containers/${created.Id}/rename?name=${encodeURIComponent(name)}`);
    return { containerId: created.Id, name, state: 'prepared-stopped', maskedPaths: policy.maskedPaths, readonlyPaths: policy.readonlyPaths };
  } catch (error) {
    if (created && !removedOriginal) await api('DELETE', `/containers/${created.Id}`).catch(() => {});
    if (removedOriginal) throw new Error(`Replacement ${created.Id} remains stopped; resolve its name before starting: ${error.message}`);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [id, policyFile, evidenceDir] = process.argv.slice(2);
  assert.ok(id && policyFile && evidenceDir, 'Usage: node scoped-proc-policy.mjs <stopped-container> <policy.json> <private-evidence-dir>');
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const context = spawnSync('docker', ['context', 'inspect'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(context.status, 0, 'Docker context unavailable');
  const endpoint = process.env.DOCKER_HOST || JSON.parse(context.stdout)[0].Endpoints.docker.Host;
  assert.ok(endpoint.startsWith('unix://'), 'Use an explicit local Docker Engine context');
  const result = await replaceStoppedContainer(
    (method, url, body) => engine(endpoint.slice(7), method, url, body), id,
    JSON.parse(fs.readFileSync(policyFile, 'utf8')),
    original => fs.writeFileSync(path.join(evidenceDir, `original-${original.Id}.private.json`), JSON.stringify(original, null, 2), { mode: 0o600, flag: 'wx' }),
  );
  console.log(JSON.stringify(result));
}
