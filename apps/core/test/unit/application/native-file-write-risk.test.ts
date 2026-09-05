import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GantryToolRiskVerdict,
  type GantryToolRisk,
} from '@core/application/permissions/gantry-tool-risk.js';
import { judgeNativeFileWrite } from '@core/application/permissions/native-file-write-risk.js';

const tempRoots: string[] = [];

function makeRoot(label: string): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `gantry-native-${label}-`),
  );
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('native file-write risk', () => {
  it('judges a native FileWrite and FileEdit destination from every supplied file_path or path key, absolute or provider-relative: inside low, dot-dot escape or conflicting dual keys or outside or undefined root high, no string destination ambiguous', async () => {
    const workspaceRoot = makeRoot('workspace');
    const outsideRoot = makeRoot('outside');
    const judge = (
      toolName: 'FileWrite' | 'FileEdit',
      toolInput: unknown,
      root: string | undefined = workspaceRoot,
    ): Promise<GantryToolRisk> =>
      judgeNativeFileWrite({ toolName, toolInput, workspaceRoot: root });

    await expect(
      judge('FileWrite', {
        file_path: path.join(workspaceRoot, 'notes', 'absolute.md'),
      }),
    ).resolves.toEqual({
      verdict: GantryToolRiskVerdict.Low,
      reason: 'native file write inside workspace',
    });
    await expect(
      judge('FileEdit', { path: 'notes/provider-relative.md' }),
    ).resolves.toMatchObject({ verdict: GantryToolRiskVerdict.Low });

    for (const result of [
      judge('FileWrite', { path: '../escape.md' }),
      judge('FileEdit', { file_path: path.join(outsideRoot, 'outside.md') }),
      judge('FileWrite', {
        file_path: path.join(workspaceRoot, 'inside.md'),
        path: path.join(outsideRoot, 'outside.md'),
      }),
      judgeNativeFileWrite({
        toolName: 'FileWrite',
        toolInput: { path: 'notes/a.md' },
      }),
    ]) {
      await expect(result).resolves.toMatchObject({
        verdict: GantryToolRiskVerdict.High,
        reason: expect.any(String),
      });
    }
    await expect(judge('FileWrite', { path: '   ' })).resolves.toEqual({
      verdict: GantryToolRiskVerdict.Ambiguous,
      reason: 'native file-write destination is missing',
    });
  });
});
