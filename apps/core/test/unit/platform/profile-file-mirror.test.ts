import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROFILE_MIRROR_HEADER,
  readProfileFileMirror,
  profileMirrorPath,
  stripProfileMirrorHeader,
  writeProfileFileMirror,
} from '@core/platform/profile-file-mirror.js';

describe('profile file mirror', () => {
  const tempDirs: string[] = [];

  function makeRuntimeHome(): string {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-mirror-'),
    );
    tempDirs.push(runtimeHome);
    return runtimeHome;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips a leading managed header (and the blank line after it)', () => {
    const body = '# Soul\n\nBe sharp.';
    const mirrored = `${PROFILE_MIRROR_HEADER}\n\n${body}`;
    expect(stripProfileMirrorHeader(mirrored)).toBe(body);
  });

  it('leaves content without the header untouched', () => {
    const body = 'no header here';
    expect(stripProfileMirrorHeader(body)).toBe(body);
  });

  it('prepends the header and stays idempotent across re-writes', async () => {
    const runtimeHome = makeRuntimeHome();
    const agentFolder = 'mirror_test_agent';
    await writeProfileFileMirror({
      runtimeHome,
      agentFolder,
      fileName: 'AGENTS.md',
      content: '# How I work',
    });
    const first = readProfileFileMirror({
      runtimeHome,
      agentFolder,
      fileName: 'AGENTS.md',
    });
    expect(first?.startsWith(PROFILE_MIRROR_HEADER)).toBe(true);
    expect(stripProfileMirrorHeader(first ?? '')).toBe('# How I work');

    // Re-mirroring a file that already carries the header must not double it.
    await writeProfileFileMirror({
      runtimeHome,
      agentFolder,
      fileName: 'AGENTS.md',
      content: first ?? '',
    });
    const second = readProfileFileMirror({
      runtimeHome,
      agentFolder,
      fileName: 'AGENTS.md',
    });
    expect(second).toBe(first);
    expect((second ?? '').split(PROFILE_MIRROR_HEADER).length - 1).toBe(1);
  });

  it('writes mirrors under the selected runtime home', async () => {
    const runtimeHome = makeRuntimeHome();
    await writeProfileFileMirror({
      runtimeHome,
      agentFolder: 'scoped_agent',
      fileName: 'SOUL.md',
      content: '# Scoped soul',
    });

    const targetPath = profileMirrorPath('scoped_agent', 'SOUL.md', {
      runtimeHome,
    });
    expect(targetPath).toBe(
      path.join(runtimeHome, 'agents', 'scoped_agent', 'SOUL.md'),
    );
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(
      stripProfileMirrorHeader(
        readProfileFileMirror({
          runtimeHome,
          agentFolder: 'scoped_agent',
          fileName: 'SOUL.md',
        }) ?? '',
      ),
    ).toBe('# Scoped soul');
  });

  it('uses a non-reserved mirror file name for AGENTS.md', async () => {
    const runtimeHome = makeRuntimeHome();
    await writeProfileFileMirror({
      runtimeHome,
      agentFolder: 'reserved_agent',
      fileName: 'AGENTS.md',
      content: '# Reviewed instructions',
    });

    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', 'reserved_agent', 'AGENTS.md'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'agents', 'reserved_agent', 'AGENTS.profile.md'),
      ),
    ).toBe(true);
  });

  it('keeps newer mirrored content when an older version arrives later', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'ordered_agent',
      fileName: 'SOUL.md',
    };

    await writeProfileFileMirror({ ...input, content: '# v11', version: 11 });
    await expect(
      writeProfileFileMirror({ ...input, content: '# v10', version: 10 }),
    ).resolves.toBeUndefined();

    expect(stripProfileMirrorHeader(readProfileFileMirror(input) ?? '')).toBe(
      '# v11',
    );
  });

  it('replaces older mirrored content with a newer version', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'newer_agent',
      fileName: 'SOUL.md',
    };

    await writeProfileFileMirror({ ...input, content: '# v10', version: 10 });
    await writeProfileFileMirror({ ...input, content: '# v11', version: 11 });

    expect(stripProfileMirrorHeader(readProfileFileMirror(input) ?? '')).toBe(
      '# v11',
    );
  });

  it('serializes overlapping writes to the same target', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'concurrent_agent',
      fileName: 'SOUL.md',
    };
    const rename = fsp.rename.bind(fsp);
    let releaseFirstRename!: () => void;
    const firstRenameBlocked = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    const renameSpy = vi
      .spyOn(fsp, 'rename')
      .mockImplementationOnce(async (...args) => {
        await firstRenameBlocked;
        await rename(...args);
      });

    const older = writeProfileFileMirror({
      ...input,
      content: '# v10',
      version: 10,
    });
    await vi.waitFor(() => expect(renameSpy).toHaveBeenCalledTimes(1));

    const newer = writeProfileFileMirror({
      ...input,
      content: '# v11',
      version: 11,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renameSpy).toHaveBeenCalledTimes(1);

    releaseFirstRename();
    await Promise.all([older, newer]);

    expect(renameSpy).toHaveBeenCalledTimes(2);
    expect(stripProfileMirrorHeader(readProfileFileMirror(input) ?? '')).toBe(
      '# v11',
    );
  });

  it('does not record a version when its write fails', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'retry_agent',
      fileName: 'SOUL.md',
      content: '# retry v11',
      version: 11,
    };
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('rename failed'));

    await expect(writeProfileFileMirror(input)).rejects.toThrow(
      'rename failed',
    );
    await expect(writeProfileFileMirror(input)).resolves.toBeUndefined();

    expect(stripProfileMirrorHeader(readProfileFileMirror(input) ?? '')).toBe(
      '# retry v11',
    );
  });

  it('continues to write unversioned mirrors unconditionally', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'unversioned_agent',
      fileName: 'SOUL.md',
    };

    await writeProfileFileMirror({
      ...input,
      content: '# versioned',
      version: 11,
    });
    await writeProfileFileMirror({ ...input, content: '# unversioned' });

    expect(stripProfileMirrorHeader(readProfileFileMirror(input) ?? '')).toBe(
      '# unversioned',
    );
  });

  it('rejects symlinked agent mirror directories', async () => {
    const runtimeHome = makeRuntimeHome();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-outside-'));
    tempDirs.push(outside);
    fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(runtimeHome, 'agents', 'linked_agent'));
    } catch {
      return;
    }

    await expect(
      writeProfileFileMirror({
        runtimeHome,
        agentFolder: 'linked_agent',
        fileName: 'AGENTS.md',
        content: '# unsafe',
      }),
    ).rejects.toThrow('not a safe directory');
  });
});
