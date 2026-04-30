import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { afterAll } from 'vitest';

const runtimeHome = path.join(
  os.tmpdir(),
  `myclaw-vitest-runtime-${process.pid}`,
);
const settingsPath = path.join(runtimeHome, 'settings.yaml');

const settingsYaml = [
  'channels:',
  '  telegram:',
  '    enabled: false',
  '    sender_allowlist:',
  '      default:',
  '        allow: "*"',
  '        mode: trigger',
  '      agents: {}',
  '      log_denied: true',
  '    control_allowlist:',
  '      default: []',
  '      agents: {}',
  '  slack:',
  '    enabled: false',
  '    sender_allowlist:',
  '      default:',
  '        allow: "*"',
  '        mode: trigger',
  '      agents: {}',
  '      log_denied: true',
  '    control_allowlist:',
  '      default: []',
  '      agents: {}',
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
  '      extractor: claude-haiku-4-5-20251001',
  '      dreaming: claude-sonnet-4-6',
  '      consolidation: claude-sonnet-4-6',
  'storage:',
  '  postgres:',
  '    url_env: MYCLAW_DATABASE_URL',
  '    schema: myclaw',
  '',
].join('\n');

fs.mkdirSync(runtimeHome, { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'store'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'data'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'memory'), { recursive: true });
fs.writeFileSync(settingsPath, settingsYaml, 'utf-8');

process.env.MYCLAW_HOME = runtimeHome;

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
        !command.includes('myclaw-browser-')
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
