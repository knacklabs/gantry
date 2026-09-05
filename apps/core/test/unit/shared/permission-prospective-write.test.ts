import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { evaluateProspectiveWriteBoundary } from '@core/shared/permission-prospective-write.js';

const tempRoots: string[] = [];

function makeRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gantry-write-${label}-`));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('prospective write boundary', () => {
  it('evaluates a prospective write boundary fail-closed: inside allows including a missing target; outside, protected, hidden, secret, symlinked parent, symlinked target, unresolvable or non-absolute root and a filesystem error refuse without throwing', async () => {
    const workspaceRoot = makeRoot('workspace');
    const outsideRoot = makeRoot('outside');
    fs.mkdirSync(path.join(workspaceRoot, 'notes'));
    fs.writeFileSync(path.join(workspaceRoot, 'notes', 'existing.md'), 'safe');
    fs.writeFileSync(path.join(workspaceRoot, 'plain-file'), 'not a directory');
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, 'linked-parent'));
    fs.symlinkSync(
      path.join(outsideRoot, 'target.md'),
      path.join(workspaceRoot, 'linked-target.md'),
    );

    const evaluate = (candidatePath: string, root = workspaceRoot) =>
      evaluateProspectiveWriteBoundary({ workspaceRoot: root, candidatePath });

    await expect(evaluate('notes/existing.md')).resolves.toEqual({
      inside: true,
    });
    await expect(evaluate('notes/missing.md')).resolves.toEqual({
      inside: true,
    });

    for (const candidatePath of [
      '../outside.md',
      'settings.yaml',
      '.private/notes.md',
      'config/private-key.pem',
      'linked-parent/new.md',
      'linked-parent/../victim',
      'linked-target.md',
      'plain-file/child.md',
    ]) {
      await expect(evaluate(candidatePath)).resolves.toMatchObject({
        inside: false,
        reason: expect.any(String),
      });
    }
    await expect(
      evaluate('notes/a.md', path.join(workspaceRoot, 'missing-root')),
    ).resolves.toMatchObject({ inside: false, reason: expect.any(String) });
    await expect(evaluate('notes/a.md', 'relative-root')).resolves.toEqual({
      inside: false,
      reason: 'workspace root must be absolute',
    });
  });
});
