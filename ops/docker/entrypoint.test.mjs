import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(new URL('./entrypoint.sh', import.meta.url), 'utf8').split('rand_base64_32()')[0];
function verify(env) {
  return spawnSync('sh', ['-c', `${source}\nvalidate_runtime_paths\nprintf '%s\\n' "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"`], { encoding: 'utf8', env: { ...process.env, ...env } });
}
test('non-root startup provides writable Chromium config/cache in state, preserving overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-entrypoint-'));
  try {
    const result = verify({ GANTRY_HOME: root, XDG_CONFIG_HOME: '', XDG_CACHE_HOME: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${root}/config\n${root}/cache\n`);
    const custom = verify({ GANTRY_HOME: root, XDG_CONFIG_HOME: `${root}/custom/config`, XDG_CACHE_HOME: `${root}/custom/cache` });
    assert.equal(custom.status, 0, custom.stderr);
    assert.ok(fs.statSync(`${root}/custom/cache`).isDirectory());
    fs.writeFileSync(`${root}/blocked`, 'not a directory');
    const denied = verify({ GANTRY_HOME: root, XDG_CONFIG_HOME: `${root}/blocked/config` });
    assert.equal(denied.status, 78);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
