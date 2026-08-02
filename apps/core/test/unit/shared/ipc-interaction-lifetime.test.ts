import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasIpcRequestClaimMarker } from '@core/shared/ipc-interaction-lifetime.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('hasIpcRequestClaimMarker', () => {
  it('uses the filesystem probe by default', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-claim-probe-'),
    );
    tempDirs.push(tempDir);
    const requestPath = path.join(tempDir, 'request.json');
    fs.writeFileSync(path.join(tempDir, '.processing-host-request.json'), '{}');

    expect(hasIpcRequestClaimMarker(requestPath)).toBe(true);
  });

  it('accepts an injected probe and fails closed if it throws', () => {
    const probe = vi.fn(() => true);

    expect(hasIpcRequestClaimMarker('/request.json', probe)).toBe(true);
    expect(probe).toHaveBeenCalledWith('/request.json');
    expect(
      hasIpcRequestClaimMarker('/request.json', () => {
        throw new Error('probe unavailable');
      }),
    ).toBe(false);
  });
});
