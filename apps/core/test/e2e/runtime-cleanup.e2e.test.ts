import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'apps/core/src/cli/index.ts');
const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');

function runCli(args: string[], runtimeHome: string) {
  return spawnSync(tsxBin, [cliEntry, '--runtime-home', runtimeHome, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GANTRY_HOME: runtimeHome,
      NODE_ENV: 'test',
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

function writeMinimalRuntime(runtimeHome: string): void {
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeHome, 'settings.yaml'),
    [
      'providers:',
      '  app:',
      '    enabled: true',
      '  slack:',
      '    enabled: false',
      '  telegram:',
      '    enabled: false',
      'memory:',
      '  enabled: true',
      '  embeddings:',
      '    enabled: false',
      '    provider: disabled',
      '    model: text-embedding-3-large',
      '  dreaming:',
      '    enabled: false',
      '  llm:',
      '    models:',
      '      extractor: haiku',
      '      dreaming: sonnet',
      '      consolidation: sonnet',
      'storage:',
      '  postgres:',
      '    url_env: GANTRY_DATABASE_URL',
      '    schema: gantry',
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe('runtime cleanup CLI e2e', () => {
  let runtimeHome = '';

  beforeEach(() => {
    runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cli-e2e-'));
  });

  afterEach(() => {
    if (runtimeHome) {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
      runtimeHome = '';
    }
  });

  it('can render help on a fresh runtime home without creating settings', () => {
    const result = runCli(['--help'], runtimeHome);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Gantry CLI');
    expect(fs.existsSync(path.join(runtimeHome, 'settings.yaml'))).toBe(false);
  }, 20_000);

  it('rejects removed memory commands through the top-level CLI surface', () => {
    writeMinimalRuntime(runtimeHome);

    const result = runCli(['memory', 'health', 'divergence'], runtimeHome);

    expect(result.status).toBe(1);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('gantry memory status [--json]');
    expect(output).not.toContain('gantry memory health journal-status');
  }, 20_000);
});
