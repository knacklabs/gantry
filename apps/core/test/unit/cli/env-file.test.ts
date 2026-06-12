import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  parseEnvContent,
  readEnvFile,
  upsertEnvFile,
} from '@core/config/env/file.js';

describe('cli env-file helpers', () => {
  it('parses env content and decodes quoted values', () => {
    const parsed = parseEnvContent(
      [
        '# comment',
        'A=1',
        'B="hello world"',
        "C='quoted'",
        'D=',
        'E="[{\\"kid\\":\\"admin\\"}]"',
        '',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      A: '1',
      B: 'hello world',
      C: 'quoted',
      D: '',
      E: '[{"kid":"admin"}]',
    });
  });

  it('upserts env values and removes null keys', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-env-'));
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

  it('round-trips JSON-valued secrets through env writes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-env-json-'));
    const envPath = path.join(tmpDir, '.env');
    const controlKeysJson = JSON.stringify([
      {
        kid: 'admin',
        token: 'control-token-6bc88e9f0a1249d9b5fd7a1a',
        appId: 'default',
        scopes: ['sessions:read'],
      },
    ]);

    try {
      upsertEnvFile(envPath, {
        GANTRY_CONTROL_API_KEYS_JSON: controlKeysJson,
      });

      expect(readEnvFile(envPath).GANTRY_CONTROL_API_KEYS_JSON).toBe(
        controlKeysJson,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
