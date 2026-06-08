import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { afterAll, beforeEach } from 'vitest';

import { clearCachedSystemPrompt } from '@core/runtime/prompt-cache.js';

const runtimeHome = path.join(
  os.tmpdir(),
  `gantry-vitest-runtime-${process.pid}`,
);
const settingsPath = path.join(runtimeHome, 'settings.yaml');

const settingsYaml = [
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
fs.writeFileSync(settingsPath, settingsYaml, 'utf-8');

process.env.GANTRY_HOME = runtimeHome;

// The runtime rejects non-secret LLM routing config (e.g. ANTHROPIC_BASE_URL)
// in the process environment — it belongs in settings.yaml. Some dev shells and
// the Claude Code harness inject it; strip it here so settings/preflight
// validation tests are deterministic regardless of who runs them.
delete process.env.ANTHROPIC_BASE_URL;

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

// Reset the process-lifetime compiled system-prompt cache between tests so a
// prompt cached by one spawn test does not leak into the next.
beforeEach(() => {
  clearCachedSystemPrompt();
});

afterAll(() => {
  cleanupOwnedBrowsers();
});
