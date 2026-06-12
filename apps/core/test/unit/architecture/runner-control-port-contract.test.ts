import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const sourceRoot = path.join(repoRoot, 'apps/core/src');
const allowedDurableContractPath =
  'apps/core/src/runtime/runner-control-port.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

describe('runner control port contract boundary', () => {
  it('keeps DurableRunnerControlPort contract-only with no remote worker implementation', () => {
    const durableMatches: string[] = [];
    const remoteWorkerMatches: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      const rel = path.relative(repoRoot, file);
      const text = fs.readFileSync(file, 'utf-8');
      if (text.includes('DurableRunnerControlPort')) durableMatches.push(rel);
      if (/\b(RemoteRunner|RemoteWorker|WorkerRunnerControl)\b/.test(text)) {
        remoteWorkerMatches.push(rel);
      }
    }

    expect(durableMatches).toEqual([allowedDurableContractPath]);
    expect(remoteWorkerMatches).toEqual([]);
  });
});
