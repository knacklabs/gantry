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
  stripProfileMirrorMarker,
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

  async function mirrorDistinctTargets(
    runtimeHome: string,
    prefix: string,
    count: number,
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await writeProfileFileMirror({
        runtimeHome,
        agentFolder: `${prefix}_${index}`,
        fileName: 'SOUL.md',
        content: `# v${index}`,
        version: index,
      });
    }
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
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# v11\n<!-- gantry-profile-version: 11 -->`,
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
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# v11\n<!-- gantry-profile-version: 11 -->`,
    );
  });

  it('keeps the ordering guard after a simulated restart', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'restarted_agent',
      fileName: 'SOUL.md',
    };
    const targetPath = profileMirrorPath(input.agentFolder, input.fileName, {
      runtimeHome,
    });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      `${PROFILE_MIRROR_HEADER}\n\n# v11\n<!-- gantry-profile-version: 11 -->`,
      'utf-8',
    );

    await writeProfileFileMirror({
      ...input,
      content: '# stale v10',
      version: 10,
    });

    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# v11\n<!-- gantry-profile-version: 11 -->`,
    );
  });

  it('writes the first version when the target is missing', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'fresh_agent',
      fileName: 'SOUL.md',
    };

    await writeProfileFileMirror({
      ...input,
      content: '# first version',
      version: 11,
    });

    expect(stripProfileMirrorHeader(readProfileFileMirror(input) ?? '')).toBe(
      '# first version',
    );
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# first version\n<!-- gantry-profile-version: 11 -->`,
    );
  });

  it('writes over an existing target with no marker', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'unversioned_target_agent',
      fileName: 'SOUL.md',
    };
    const targetPath = profileMirrorPath(input.agentFolder, input.fileName, {
      runtimeHome,
    });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      `${PROFILE_MIRROR_HEADER}\n\n# unversioned`,
      'utf-8',
    );

    await writeProfileFileMirror({
      ...input,
      content: '# versioned',
      version: 10,
    });

    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# versioned\n<!-- gantry-profile-version: 10 -->`,
    );
  });

  it('treats a malformed marker as having no recorded version', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'malformed_marker_agent',
      fileName: 'SOUL.md',
    };
    const targetPath = profileMirrorPath(input.agentFolder, input.fileName, {
      runtimeHome,
    });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      `${PROFILE_MIRROR_HEADER}\n\n# malformed\n<!-- gantry-profile-version: nope -->`,
      'utf-8',
    );

    await writeProfileFileMirror({
      ...input,
      content: '# recovered',
      version: 10,
    });

    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# recovered\n<!-- gantry-profile-version: 10 -->`,
    );
  });

  it('fails closed when the existing target cannot be read', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'unreadable_target_agent',
      fileName: 'SOUL.md',
    };
    const targetPath = profileMirrorPath(input.agentFolder, input.fileName, {
      runtimeHome,
    });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, '# existing', 'utf-8');
    vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );

    await expect(
      writeProfileFileMirror({
        ...input,
        content: '# must not replace',
        version: 10,
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });

    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('# existing');
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
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# v11\n<!-- gantry-profile-version: 11 -->`,
    );
  });

  it('retries a version after its atomic write fails', async () => {
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
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# retry v11\n<!-- gantry-profile-version: 11 -->`,
    );
  });

  it('clears the version claim on an unversioned write', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'unversioned_agent',
      fileName: 'SOUL.md',
    };

    await writeProfileFileMirror({
      ...input,
      content: '# first v11',
      version: 11,
    });
    await writeProfileFileMirror({ ...input, content: '# unversioned' });
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# unversioned`,
    );

    await writeProfileFileMirror({
      ...input,
      content: '# retried v11',
      version: 11,
    });
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# retried v11\n<!-- gantry-profile-version: 11 -->`,
    );
  });

  it('strips the version marker when mirrored content is read back', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'marker_reader_agent',
      fileName: 'SOUL.md',
    };

    await writeProfileFileMirror({
      ...input,
      content: '# visible content',
      version: 11,
    });

    const raw = readRawMirror(input);
    expect(raw).toContain('<!-- gantry-profile-version: 11 -->');
    expect(readProfileFileMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# visible content`,
    );
    expect(stripProfileMirrorMarker(raw)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# visible content`,
    );
  });

  it('keeps the ordering guard after many other targets are mirrored', async () => {
    const runtimeHome = makeRuntimeHome();
    const input = {
      runtimeHome,
      agentFolder: 'guarded_agent',
      fileName: 'SOUL.md',
    };
    await writeProfileFileMirror({
      ...input,
      content: '# guarded v11',
      version: 11,
    });

    await mirrorDistinctTargets(runtimeHome, 'other_agent', 600);
    await writeProfileFileMirror({
      ...input,
      content: '# stale v10',
      version: 10,
    });

    expect(stripProfileMirrorHeader(readProfileFileMirror(input) ?? '')).toBe(
      '# guarded v11',
    );
    expect(readRawMirror(input)).toBe(
      `${PROFILE_MIRROR_HEADER}\n\n# guarded v11\n<!-- gantry-profile-version: 11 -->`,
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
