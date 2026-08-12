import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const value = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const id = value('--id');
const path = value('--path');
const report = value('--report');

if (!id || !path || !report) process.exit(2);

const vitest = fileURLToPath(
  new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [vitest, 'run', '-c', 'apps/web/vitest.config.ts', path, '-t', id],
  { stdio: 'inherit' },
);

if (result.status !== 0) process.exit(result.status ?? 1);

const escapeXml = (input) =>
  input
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

writeFileSync(
  report,
  `<testsuites tests="1" failures="0"><testsuite tests="1" failures="0"><testcase name="${escapeXml(id)}" file="${escapeXml(path)}"/></testsuite></testsuites>`,
);
