#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith('--') || !value) {
    throw new Error('Expected --path, --id and --report value pairs.');
  }
  values.set(flag, value);
}

const testPath = values.get('--path');
const testId = values.get('--id');
const reportPath = values.get('--report');
if (!testPath || !testId || !reportPath) {
  throw new Error('Missing --path, --id or --report.');
}

const normalizedPath = testPath.replaceAll('\\', '/');
if (
  path.isAbsolute(testPath) ||
  normalizedPath.includes('../') ||
  !normalizedPath.endsWith('.test.ts') ||
  !existsSync(path.resolve(normalizedPath))
) {
  throw new Error(`Invalid repository-relative test path: ${testPath}`);
}

const leafTitle = testId.split(' > ').at(-1)?.trim();
if (!leafTitle) {
  throw new Error('The exact JUnit test id must include a test title.');
}

const vitest = path.resolve('node_modules/vitest/vitest.mjs');
const candidatePattern = leafTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    '--config',
    'vitest.unit.config.ts',
    normalizedPath,
    '-t',
    candidatePattern,
    '--outputFile',
    reportPath,
  ],
  {
    env: { ...process.env, VITEST_JUNIT: '1' },
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const escapedId = testId
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');
const report = readFileSync(reportPath, 'utf8');
const marker = `name="${escapedId}"`;
const markerAt = report.indexOf(marker);
const caseStart = report.lastIndexOf('<testcase', markerAt);
const caseEnd = report.indexOf('</testcase>', markerAt);
if (
  markerAt < 0 ||
  report.indexOf(marker, markerAt + marker.length) >= 0 ||
  caseStart < 0 ||
  caseEnd < 0 ||
  /<(?:failure|error|skipped)\b/.test(report.slice(caseStart, caseEnd))
) {
  throw new Error(
    `JUnit did not contain one passing testcase named: ${testId}`,
  );
}
