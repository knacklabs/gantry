import { spawnSync } from 'node:child_process';

let python = 'python3';
if (process.platform === 'win32') {
  // Forge's Windows installer provides uv-managed Python; python3 can be a
  // Microsoft Store alias even when that interpreter is installed.
  const found = spawnSync('uv', ['python', 'find'], { encoding: 'utf8' });
  if (found.error || found.status !== 0) {
    process.stderr.write(
      'Python is unavailable. Repair the Forge Python setup with uv.\n',
    );
    process.exit(found.status || 1);
  }
  python = found.stdout.trim();
}

const result = spawnSync(
  python,
  ['scripts/check_architecture.py', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1' },
  },
);
if (result.error) {
  process.stderr.write(
    'Cannot start the architecture check. Install Python and try again.\n',
  );
}
process.exit(result.status ?? 1);
