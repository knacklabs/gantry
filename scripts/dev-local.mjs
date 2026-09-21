import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['run', 'cli:dev', '--', 'local', 'start'], {
  env: { ...process.env, GANTRY_DEV_AUTHORIZATION_LINK: '1' },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
