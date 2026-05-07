import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PRIVATE_FILE_MODE,
  writePrivateFileSync,
} from '@core/shared/private-fs.js';

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('private fs helpers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-fs-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('repairs permissions when overwriting an existing private file', () => {
    const filePath = path.join(tempDir, 'ipc-payload.json');
    fs.writeFileSync(filePath, '{}', { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);

    writePrivateFileSync(filePath, '{"ok":true}');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"ok":true}');
    expect(fileMode(filePath)).toBe(PRIVATE_FILE_MODE);
  });

  it('rejects existing symlink destinations', () => {
    const targetPath = path.join(tempDir, 'target.json');
    const linkPath = path.join(tempDir, 'ipc-payload.json');
    fs.writeFileSync(targetPath, '{}', { mode: PRIVATE_FILE_MODE });
    fs.symlinkSync(targetPath, linkPath);

    expect(() => writePrivateFileSync(linkPath, '{"ok":true}')).toThrow(
      'Refusing to write private file through symlink',
    );
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('{}');
  });

  it('rejects broken symlink destinations', () => {
    const targetPath = path.join(tempDir, 'missing-target.json');
    const linkPath = path.join(tempDir, 'ipc-payload.json');
    fs.symlinkSync(targetPath, linkPath);

    expect(() => writePrivateFileSync(linkPath, '{"ok":true}')).toThrow(
      'Refusing to write private file through symlink',
    );
    expect(fs.existsSync(targetPath)).toBe(false);
  });
});
