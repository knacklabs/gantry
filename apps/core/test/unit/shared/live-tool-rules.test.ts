import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendLiveToolRules,
  readLiveToolRules,
} from '@core/shared/live-tool-rules.js';
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
} from '@core/shared/private-fs.js';

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('live tool rules', () => {
  it('stores same-run tool grants in private files', () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tools-'));

    const rules = appendLiveToolRules({
      ipcDir,
      runHandle: 'run_1',
      rules: ['Read(/repo/**)', 'Read(/repo/**)', 'Bash(git status)'],
    });

    const filePath = path.join(ipcDir, 'live-tool-rules', 'run_1.json');
    expect(rules).toEqual(['Read(/repo/**)', 'Bash(git status)']);
    expect(readLiveToolRules({ ipcDir, runHandle: 'run_1' })).toEqual(rules);
    expect(mode(path.dirname(filePath))).toBe(PRIVATE_DIR_MODE);
    expect(mode(filePath)).toBe(PRIVATE_FILE_MODE);
  });

  it('ignores invalid run handles without touching the filesystem', () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tools-'));

    expect(
      appendLiveToolRules({
        ipcDir,
        runHandle: '../run',
        rules: ['Read'],
      }),
    ).toEqual([]);
    expect(fs.existsSync(path.join(ipcDir, 'live-tool-rules'))).toBe(false);
  });
});
