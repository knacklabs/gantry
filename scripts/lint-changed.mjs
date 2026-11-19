import { execFileSync, spawnSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const base = git('merge-base', 'HEAD', 'origin/main').trim();
const paths = [
  git(
    'diff',
    '-z',
    '--name-only',
    '--diff-filter=ACMR',
    base,
    '--',
    '*.ts',
    '*.tsx',
  ),
  git('ls-files', '-z', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'),
].flatMap((output) => output.split('\0').filter(Boolean));

if (paths.length > 0) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/eslint/bin/eslint.js', '--', ...new Set(paths)],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
