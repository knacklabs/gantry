import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROFILE_MIRROR_HEADER,
  profileMirrorPath,
  readProfileFileMirror,
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

  function readRawMirror(input: {
    runtimeHome: string;
    agentFolder: string;
    fileName: string;
  }): string {
    const targetPath = profileMirrorPath(input.agentFolder, input.fileName, {
      runtimeHome: input.runtimeHome,
    });
    return fs.readFileSync(targetPath, 'utf-8');
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

  it('serializes a slow v10 before v11 and leaves v11 content', async () => {
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
    expect(readRawMirror(input)).toBe(`${PROFILE_MIRROR_HEADER}\n\n# v11`);
  });

  it('skips v10 issued behind v11 while the target chain is active', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'stale_agent',
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

    const newer = writeProfileFileMirror({
      ...input,
      content: '# v11',
      version: 11,
    });
    await vi.waitFor(() => expect(renameSpy).toHaveBeenCalledTimes(1));
    const older = writeProfileFileMirror({
      ...input,
      content: '# v10',
      version: 10,
    });

    releaseFirstRename();
    await Promise.all([newer, older]);

    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(readRawMirror(input)).toBe(`${PROFILE_MIRROR_HEADER}\n\n# v11`);
  });

  it('forgets the applied version when the target chain drains', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'drained_agent',
      fileName: 'SOUL.md',
    };

    await writeProfileFileMirror({ ...input, content: '# v11', version: 11 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await writeProfileFileMirror({ ...input, content: '# v10', version: 10 });

    expect(readRawMirror(input)).toBe(`${PROFILE_MIRROR_HEADER}\n\n# v10`);
  });

  it('allows a versionless call to write while the target chain is active', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'versionless_agent',
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

    const versioned = writeProfileFileMirror({
      ...input,
      content: '# v11',
      version: 11,
    });
    await vi.waitFor(() => expect(renameSpy).toHaveBeenCalledTimes(1));
    const versionless = writeProfileFileMirror({
      ...input,
      content: '# versionless',
    });

    releaseFirstRename();
    await Promise.all([versioned, versionless]);

    expect(renameSpy).toHaveBeenCalledTimes(2);
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# versionless`,
    );
  });

  it('does not record a version when its atomic write fails', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'retry_agent',
      fileName: 'SOUL.md',
      content: '# retry v11',
      version: 11,
    };
    const rename = fsp.rename.bind(fsp);
    let rejectFirstRename!: () => void;
    const firstRenameBlocked = new Promise<void>((resolve) => {
      rejectFirstRename = resolve;
    });
    const renameSpy = vi
      .spyOn(fsp, 'rename')
      .mockImplementationOnce(async () => {
        await firstRenameBlocked;
        throw new Error('rename failed');
      })
      .mockImplementation(rename);

    const failed = writeProfileFileMirror(input);
    await vi.waitFor(() => expect(renameSpy).toHaveBeenCalledTimes(1));
    const retry = writeProfileFileMirror(input);

    rejectFirstRename();
    await expect(failed).rejects.toThrow('rename failed');
    await expect(retry).resolves.toBeUndefined();

    expect(renameSpy).toHaveBeenCalledTimes(2);
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# retry v11`,
    );
  });

  it('writes only the managed header and caller content', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'content_only_agent',
      fileName: 'SOUL.md',
    };

    await writeProfileFileMirror({
      ...input,
      content: '# visible content',
      version: 11,
    });

    const raw = readRawMirror(input);
    expect(raw).toBe(`${PROFILE_MIRROR_HEADER}\n\n# visible content`);
    expect(raw).not.toContain('gantry-profile-version');
    expect(readProfileFileMirror(input)).toBe(raw);
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
