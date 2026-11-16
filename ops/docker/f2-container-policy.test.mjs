import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateFor, validateDisposable, publicEvidence } from './f2-container-policy.mjs';

const baseline = () => ({
  Image: `sha256:${'1'.repeat(64)}`, User: '', Env: [
    'SECRET=do-not-print',
    'GANTRY_DATABASE_URL=postgresql://fixture:fixture@gantry-f2-postgres:5432/gantry_f2_fixture',
  ],
  Cmd: ['node', 'dist/index.js'], Labels: { 'gantry.f2.disposable': 'true' },
  HostConfig: {
    Privileged: true, SecurityOpt: ['seccomp=unconfined', 'no-new-privileges=true'],
    CapDrop: [], ReadonlyRootfs: false, NetworkMode: 'gantry-f2-fixture',
    Binds: [], Mounts: [{ Type: 'volume', Source: 'gantry-f2-state', Target: '/var/lib/gantry' }],
    PortBindings: { '3939/tcp': [{ HostIp: '127.0.0.1', HostPort: '3997' }] },
    MaskedPaths: ['/proc/kcore', '/proc/keys', '/sys/firmware'],
    ReadonlyPaths: ['/proc/sys', '/proc/irq'],
  },
});

test('the first comparison changes only privileged, preserving the exact image, user and settings', () => {
  const before = baseline();
  const after = candidateFor(before, 'privileged-off');
  assert.equal(before.HostConfig.Privileged, true);
  const expected = baseline(); expected.HostConfig.Privileged = false;
  assert.deepEqual(after, expected);
});

test('later restrictions cannot run while privileged mode remains enabled', () => {
  assert.throws(() => candidateFor(baseline(), 'non-root'), /privileged-off/);
});

test('capability and seccomp stages preserve no-new-privileges and unrelated settings', () => {
  let spec = candidateFor(baseline(), 'privileged-off');
  spec = candidateFor(spec, 'non-root');
  assert.equal(spec.User, '1000:1000');
  spec = candidateFor(spec, 'drop-capabilities');
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  spec = candidateFor(spec, 'default-seccomp');
  assert.deepEqual(spec.HostConfig.SecurityOpt, ['no-new-privileges=true']);
  assert.deepEqual(spec.Env, baseline().Env);
});

test('a proc exception removes only explicitly selected existing proc paths', () => {
  const spec = candidateFor(baseline(), 'privileged-off');
  const after = candidateFor(spec, 'proc-paths', { removeMasked: ['/proc/kcore'], removeReadonly: [] });
  assert.deepEqual(after.HostConfig.MaskedPaths, ['/proc/keys', '/sys/firmware']);
  assert.deepEqual(after.HostConfig.ReadonlyPaths, spec.HostConfig.ReadonlyPaths);
  assert.deepEqual(after.HostConfig.SecurityOpt, spec.HostConfig.SecurityOpt);
  assert.throws(() => candidateFor(spec, 'proc-paths', { removeMasked: ['/sys/firmware'] }), /existing \/proc\//);
  assert.throws(() => candidateFor(spec, 'proc-paths', { removeMasked: ['/proc/not-present'] }), /existing \/proc\//);
});

test('the harness refuses production state, sockets, host namespaces and devices', () => {
  for (const mutate of [
    s => { s.Labels = {}; },
    s => { s.HostConfig.NetworkMode = 'host'; },
    s => { s.HostConfig.PidMode = 'host'; },
    s => { s.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; },
    s => { s.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']; },
    s => { s.HostConfig.Mounts[0].Source = 'production-home'; },
    s => { s.HostConfig.PortBindings['3939/tcp'][0].HostIp = '0.0.0.0'; },
    s => { s.HostConfig.RestartPolicy = { Name: 'unless-stopped' }; },
    s => { s.Env.push('GANTRY_DATABASE_URL=postgresql://fixture@production:5432/gantry'); },
  ]) {
    const spec = baseline(); mutate(spec);
    assert.throws(() => validateDisposable(spec));
  }
  assert.doesNotThrow(() => validateDisposable(baseline()));
});

test('read-only root does not change the writable state and temporary mounts', () => {
  const before = candidateFor(baseline(), 'privileged-off');
  before.HostConfig.Tmpfs = { '/tmp': 'rw,nosuid,nodev,size=128m' };
  const after = candidateFor(before, 'readonly-root');
  assert.equal(after.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(after.HostConfig.Mounts, before.HostConfig.Mounts);
  assert.deepEqual(after.HostConfig.Tmpfs, before.HostConfig.Tmpfs);
});

test('the existing postgres service alias is usable only with a fresh F2 database', () => {
  const spec = baseline();
  spec.Env = ['GANTRY_DATABASE_URL=postgresql://fixture:fixture@postgres:5432/gantry_f2_fixture'];
  assert.doesNotThrow(() => validateDisposable(spec));
  spec.Env = ['GANTRY_DATABASE_URL=postgresql://fixture:fixture@postgres:5432/production'];
  assert.throws(() => validateDisposable(spec));
});

test('public evidence omits environment values and command arguments', () => {
  const evidence = publicEvidence(candidateFor(baseline(), 'privileged-off'));
  assert.equal(evidence.privileged, false);
  assert.equal(evidence.image, baseline().Image);
  assert.equal(JSON.stringify(evidence).includes('do-not-print'), false);
  assert.equal(evidence.configurationSha256.length, 64);
});
