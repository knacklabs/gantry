import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { afterAll } from 'vitest';

const runtimeHome = path.join(
  os.tmpdir(),
  `gantry-vitest-runtime-${process.pid}`,
);
const settingsPath = path.join(runtimeHome, 'settings.yaml');

const settingsFileContents = [
  'providers:',
  '  telegram:',
  '    enabled: false',
  '  slack:',
  '    enabled: false',
  'memory:',
  '  enabled: true',
  '  embeddings:',
  '    enabled: false',
  '    provider: disabled',
  '    model: text-embedding-3-small',
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
].join('\n');

fs.mkdirSync(runtimeHome, { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'store'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'data'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'memory'), { recursive: true });
fs.writeFileSync(settingsPath, settingsFileContents, 'utf-8');

process.env.GANTRY_HOME = runtimeHome;

function listOwnedBrowserPids(): number[] {
  if (process.platform === 'win32') return [];
  let output = '';
  try {
    output = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf-8',
    });
  } catch {
    return [];
  }

  return output
    .split('\n')
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return [];
      const command = match[2];
      if (!/chrom(e|ium)|Google Chrome/i.test(command)) return [];
      if (!command.includes('--remote-debugging-port')) return [];
      if (
        !command.includes(runtimeHome) &&
        !command.includes('gantry-browser-')
      ) {
        return [];
      }
      return [Number(match[1])];
    })
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function cleanupOwnedBrowsers(): void {
  for (const pid of listOwnedBrowserPids()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Browser already exited.
    }
  }
}

afterAll(() => {
  cleanupOwnedBrowsers();
});
