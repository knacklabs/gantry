import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RegisteredGroup } from '@core/domain/types.js';
import {
  isTrustedRegisteredIpcFolder,
  resolveIpcFoldersFromGroups,
} from '@core/runtime/ipc.js';

function group(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@Andy',
    added_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveIpcFoldersFromGroups', () => {
  it('returns only valid registered agent folders', () => {
    expect(
      resolveIpcFoldersFromGroups({
        'tg:1': group('kai_tg_1'),
        'tg:2': group('../escape'),
        'tg:3': group(''),
        'tg:4': group('valid_agent_folder'),
      }),
    ).toEqual(['kai_tg_1', 'valid_agent_folder']);
  });

  it('deduplicates folders shared by multiple bindings', () => {
    expect(
      resolveIpcFoldersFromGroups({
        'tg:1': group('kai_tg_1'),
        'tg:2': group('kai_tg_1'),
      }),
    ).toEqual(['kai_tg_1']);
  });
});

describe('isTrustedRegisteredIpcFolder', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function tempIpcRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-ipc-root-'));
    tempRoots.push(root);
    return root;
  }

  it('allows missing registered group roots so the runtime can create them', () => {
    const ipcRoot = tempIpcRoot();

    expect(isTrustedRegisteredIpcFolder(ipcRoot, 'new_group')).toBe(true);
  });

  it('rejects registered group roots that are symlinks before processing', () => {
    const ipcRoot = tempIpcRoot();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-ipc-target-'));
    tempRoots.push(target);
    fs.symlinkSync(target, path.join(ipcRoot, 'linked_group'), 'dir');

    expect(isTrustedRegisteredIpcFolder(ipcRoot, 'linked_group')).toBe(false);
  });
});
