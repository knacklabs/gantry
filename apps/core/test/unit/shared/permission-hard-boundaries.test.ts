import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { evaluateReadHardBoundaries } from '@core/shared/permission-hard-boundaries.js';

const tempRoots: string[] = [];

function makeRoot(label: string): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `gantry-permission-boundary-${label}-`),
  );
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('permission read hard boundaries', () => {
  it('refuses out-of-workspace, protected, hidden-segment, secret and capability-boundary targets exactly as the read gate did', () => {
    const workspaceRoot = makeRoot('workspace');
    const outsideRoot = makeRoot('outside');
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'safe');
    fs.writeFileSync(path.join(workspaceRoot, 'settings.yaml'), 'protected');
    fs.writeFileSync(path.join(workspaceRoot, '.private'), 'hidden');
    fs.mkdirSync(path.join(workspaceRoot, 'config'));
    fs.writeFileSync(
      path.join(workspaceRoot, 'config', 'private-key.pem'),
      'secret',
    );
    fs.writeFileSync(path.join(outsideRoot, 'outside.txt'), 'outside');

    const evaluate = (
      target: string,
      capabilityIds: readonly string[] = ['filesystem.read'],
    ) =>
      evaluateReadHardBoundaries({
        action: 'read',
        targets: [target],
        requiresTarget: true,
        capabilityIds,
        workspaceRoot,
      });

    expect(
      evaluate(
        path.relative(workspaceRoot, path.join(outsideRoot, 'outside.txt')),
      ),
    ).toEqual({
      allowed: false,
      reason: 'The resolved file read target is not safe.',
    });
    for (const target of [
      'settings.yaml',
      '.private',
      'config/private-key.pem',
    ]) {
      expect(evaluate(target)).toEqual({
        allowed: false,
        reason: 'The resolved file read target is not safe.',
      });
    }
    expect(evaluate('README.md', ['calendar.read'])).toEqual({
      allowed: false,
      reason: 'No approved file read capability boundary matches.',
    });
  });
});
