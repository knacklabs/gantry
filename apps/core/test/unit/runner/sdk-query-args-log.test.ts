import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeSdkQueryArgsPayloadLogs } from '@core/adapters/llm/anthropic-claude-agent/runner/sdk-query-args-log.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-sdk-query-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeSdkQueryArgsPayloadLogs', () => {
  it('rewrites the latest JSON payload while preserving optional JSONL history', () => {
    const dir = makeTempDir();
    const latestPath = path.join(dir, 'llm-sdk-query-args.json');
    const historyPath = path.join(dir, 'llm-sdk-query-args.jsonl');

    writeSdkQueryArgsPayloadLogs({
      latestPath,
      historyPath,
      payload: { capturedAt: 'first', prompt: 'first prompt' },
    });
    writeSdkQueryArgsPayloadLogs({
      latestPath,
      historyPath,
      payload: { capturedAt: 'second', prompt: 'second prompt' },
    });

    expect(JSON.parse(fs.readFileSync(latestPath, 'utf8'))).toEqual({
      capturedAt: 'second',
      prompt: 'second prompt',
    });
    expect(fs.readFileSync(historyPath, 'utf8').trim().split('\n')).toHaveLength(
      2,
    );
  });
});
