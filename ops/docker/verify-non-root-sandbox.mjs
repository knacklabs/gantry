import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runComparison } from './f2-comparison.mjs';

if (process.argv.includes('--compare')) {
  const result = await runComparison();
  console.log(JSON.stringify(result, null, 2));
  process.exit(['working-first-comparison', 'working-candidate'].includes(result.status) ? 0 : 1);
}

const image = process.env.F2_GANTRY_IMAGE;
if (!image) throw new Error('F2_GANTRY_IMAGE must identify the exact local image under test');
const run = (args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 40_000 });
const identity = run(['image', 'inspect', image, '--format', '{{.Id}}']);
if (identity.status !== 0) throw new Error('F2 image unavailable');
const uid = run(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e',
  'console.log(process.getuid());if(process.getuid()===0)process.exit(1)']);
const result = { image: identity.stdout.trim(), defaultNonRoot: uid.status === 0, uid: uid.stdout.trim(),
  sandbox: 'not_run', f2Accepted: false };
if (!result.defaultNonRoot) { console.log(JSON.stringify(result)); process.exit(1); }
const profile = process.env.F2_SECCOMP_PROFILE;
const probe = process.env.F2_SANDBOX_PROBE;
if (!profile || !probe) throw new Error('F2_SECCOMP_PROFILE and F2_SANDBOX_PROBE must identify the reviewed restrictive profile and actual Gantry probe');
const execution = run(['run', '--rm', '--name', `gantry-f2-${randomUUID()}`, '--user', '1000:1000',
  '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
  '--security-opt', `seccomp=${resolve(profile)}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000',
  '--tmpfs', '/var/lib/gantry:rw,nosuid,nodev,size=128m,uid=1000,gid=1000', '-e', 'HOME=/var/lib/gantry',
  '--mount', `type=bind,source=${resolve(probe)},target=/opt/f2-probe.mjs,readonly`,
  '--entrypoint', 'node', image, '/opt/f2-probe.mjs']);
result.sandbox = execution.status === 0 ? 'passed_probe_only' : 'failed';
result.procMountDenied = /Can.t mount proc/.test(execution.stderr);
console.log(JSON.stringify(result));
process.stdout.write(execution.stdout);
process.stderr.write(execution.stderr);
// A primitive passing is insufficient: authenticated jobs/isolation/target-host gates remain separate.
process.exitCode = execution.status === 0 ? 0 : 1;
