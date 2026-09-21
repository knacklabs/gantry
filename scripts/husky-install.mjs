import { spawnSync } from 'node:child_process';

const husky = process.platform === 'win32' ? 'husky.cmd' : 'husky';
spawnSync(husky, [], {
  env: { ...process.env, HUSKY: '1' },
  stdio: 'inherit',
});
