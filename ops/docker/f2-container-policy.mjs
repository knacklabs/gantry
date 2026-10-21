import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Build one comparison without changing the supplied baseline. */
export function candidateFor(baseline, stage, options = {}) {
  const spec = structuredClone(baseline);
  const host = spec.HostConfig;
  assert.ok(host, 'Docker create specification requires HostConfig');
  if (stage === 'privileged-off') {
    host.Privileged = false;
    return spec;
  }
  assert.equal(host.Privileged, false, 'Run privileged-off before later restrictions');
  switch (stage) {
    case 'non-root': spec.User = '1000:1000'; break;
    case 'drop-capabilities': host.CapDrop = ['ALL']; break;
    case 'default-seccomp':
      host.SecurityOpt = (host.SecurityOpt ?? []).filter(s => !s.startsWith('seccomp='));
      break;
    case 'filtered-seccomp': {
      assert.equal(options.profile?.defaultAction, 'SCMP_ACT_ERRNO', 'Use a deny-by-default seccomp profile');
      host.SecurityOpt = (host.SecurityOpt ?? []).filter(s => !s.startsWith('seccomp='));
      host.SecurityOpt.push(`seccomp=${JSON.stringify(options.profile)}`);
      break;
    }
    case 'readonly-root': host.ReadonlyRootfs = true; break;
    case 'proc-paths': {
      for (const [key, removals] of [
        ['MaskedPaths', options.removeMasked ?? []],
        ['ReadonlyPaths', options.removeReadonly ?? []],
      ]) {
        assert.ok(Array.isArray(host[key]), 'Pin the effective Docker process paths before comparing');
        assert.ok(Array.isArray(removals), 'Process-path removals must be explicit arrays');
        for (const p of removals) {
          assert.ok(typeof p === 'string' && p.startsWith('/proc/') && host[key].includes(p), 'Remove only an existing /proc/ path');
        }
        host[key] = host[key].filter(p => !removals.includes(p));
      }
      break;
    }
    default: throw new Error(`Unknown F2 stage: ${stage}`);
  }
  return spec;
}

/** Refuse a comparison that could reuse application state or expose host resources. */
export function validateDisposable(spec) {
  assert.equal(spec.Labels?.['gantry.f2.disposable'], 'true', 'Require a disposable F2 fixture');
  assert.match(spec.Image, /^sha256:[a-f0-9]{64}$/, 'Pin an image identity');
  const env = Object.fromEntries((spec.Env ?? []).map(entry => {
    const at = entry.indexOf('=');
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  const database = new URL(env.GANTRY_DATABASE_URL);
  assert.match(database.hostname, /^gantry-f2-|^postgres$/, 'Use the F2 database on its private network');
  assert.match(database.pathname, /^\/gantry_f2_[a-z0-9_]+$/, 'Use a disposable F2 database');
  const h = spec.HostConfig;
  assert.match(h.NetworkMode, /^gantry-f2-/, 'Use a private F2 network');
  for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'CgroupnsMode']) {
    assert.ok(!h[key] || h[key] === 'private', `Do not share ${key}`);
  }
  for (const key of ['Devices', 'DeviceRequests', 'DeviceCgroupRules', 'Binds', 'VolumesFrom', 'Links']) {
    assert.equal((h[key] ?? []).length, 0, `Do not expose host resources through ${key}`);
  }
  assert.ok(!(h.CapAdd ?? []).some(c => ['ALL', 'SYS_ADMIN', 'CAP_SYS_ADMIN'].includes(c)), 'Do not add host administrator capabilities');
  assert.ok(!(h.SecurityOpt ?? []).includes('systempaths=unconfined'), 'Blanket process-path relaxation is not allowed');
  assert.ok(['', 'no'].includes(h.RestartPolicy?.Name ?? ''), 'Do not automatically restart F2 fixtures');
  assert.equal(h.PublishAllPorts ?? false, false, 'Do not publish all ports');
  for (const mount of h.Mounts ?? []) {
    assert.equal(mount.Type, 'volume', 'Use only F2-owned disposable volumes');
    assert.match(mount.Source, /^gantry-f2-/, 'Do not reuse application volumes');
  }
  for (const bindings of Object.values(h.PortBindings ?? {})) {
    for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1', 'Bind test ports to loopback');
  }
}

/** Summarize effective policy without exposing environment values or startup arguments. */
export function publicEvidence(spec) {
  const h = spec.HostConfig;
  return {
    image: spec.Image, user: spec.User || 'image-default', privileged: h.Privileged === true,
    capAdd: h.CapAdd ?? [], capDrop: h.CapDrop ?? [], readonlyRoot: h.ReadonlyRootfs === true,
    securityOptions: (h.SecurityOpt ?? []).map(s => s.startsWith('seccomp={') ? 'seccomp=custom-filtered' : s),
    maskedPaths: h.MaskedPaths, readonlyPaths: h.ReadonlyPaths,
    configurationSha256: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
  };
}
