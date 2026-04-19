#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const nvmrcPath = path.join(repoRoot, '.nvmrc');
const commandArgs = process.argv.slice(2);

if (commandArgs.length === 0) {
  console.error('with-project-node: missing command to run');
  process.exit(1);
}

function readRequiredVersion() {
  try {
    return fs.readFileSync(nvmrcPath, 'utf-8').trim();
  } catch {
    return '';
  }
}

function parseMajor(versionText) {
  const match = versionText.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.error) {
    console.error(
      `with-project-node: failed to start ${command}: ${result.error.message}`,
    );
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

const requiredVersion = readRequiredVersion();
const requiredMajor = parseMajor(requiredVersion);
const currentMajor = parseMajor(process.versions.node);

if (currentMajor >= requiredMajor && requiredMajor > 0) {
  run(commandArgs[0], commandArgs.slice(1));
}

const probe = spawnSync('fnm', ['--version'], {
  cwd: repoRoot,
  stdio: 'ignore',
  env: process.env,
});

if (probe.status !== 0) {
  console.error(
    `with-project-node: Node ${process.versions.node} is active, but this repo expects Node ${requiredVersion || '20+'}. Install fnm or switch Node versions before rerunning.`,
  );
  process.exit(1);
}

run('fnm', ['exec', '--using', nvmrcPath, ...commandArgs]);
