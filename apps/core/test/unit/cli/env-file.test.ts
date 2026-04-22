import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  parseEnvContent,
  readEnvFile,
  upsertEnvFile,
} from '@core/cli/env-file.js';

describe('cli env-file helpers', () => {
  it('parses env content and strips quotes', () => {
    const parsed = parseEnvContent(
      ['# comment', 'A=1', 'B="hello world"', "C='quoted'", 'D=', ''].join(
        '\n',
      ),
    );

    expect(parsed).toEqual({
      A: '1',
      B: 'hello world',
      C: 'quoted',
      D: '',
    });
  });

  it('upserts env values and removes null keys', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-env-'));
    const envPath = path.join(tmpDir, '.env');

    fs.writeFileSync(envPath, 'A=1\nREMOVE=old\n', 'utf-8');
    upsertEnvFile(envPath, {
      B: 'hello world',
      REMOVE: null,
    });

    const readBack = readEnvFile(envPath);
    expect(readBack).toEqual({
      A: '1',
      B: 'hello world',
    });
    expect((fs.statSync(envPath).mode & 0o777).toString(8)).toBe('600');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
