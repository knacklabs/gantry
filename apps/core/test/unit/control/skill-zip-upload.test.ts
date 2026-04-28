import { describe, expect, it } from 'vitest';

import { parseSkillZipUpload } from '@core/control/server/skill-zip-upload.js';

describe('skill zip upload parsing', () => {
  it('accepts a root SKILL.md and parses normalized assets', () => {
    const parsed = parseSkillZipUpload(
      makeZip({
        'SKILL.md': Buffer.from('---\nname: Root Skill\n---\n# Root'),
        'notes.txt': Buffer.from('hello'),
      }),
    );

    expect(parsed.fallbackName).toBe('uploaded-skill');
    expect(parsed.assets.map((asset) => asset.path)).toEqual([
      'SKILL.md',
      'notes.txt',
    ]);
  });

  it('accepts one top-level skill folder and strips that root', () => {
    const parsed = parseSkillZipUpload(
      makeZip({
        'my-skill/SKILL.md': Buffer.from('# Skill'),
        'my-skill/bin/run.sh': Buffer.from('echo ok'),
      }),
    );

    expect(parsed.fallbackName).toBe('my-skill');
    expect(parsed.assets.map((asset) => asset.path)).toEqual([
      'SKILL.md',
      'bin/run.sh',
    ]);
  });

  it('rejects zips without SKILL.md', () => {
    expect(() =>
      parseSkillZipUpload(makeZip({ 'README.md': Buffer.from('# No') })),
    ).toThrow(/SKILL\.md/);
  });

  it('rejects traversal paths, multiple roots, symlinks, and oversize content', () => {
    expect(() =>
      parseSkillZipUpload(makeZip({ '../SKILL.md': Buffer.from('# Bad') })),
    ).toThrow(/Invalid skill zip path/);
    expect(() =>
      parseSkillZipUpload(makeZip({ '/SKILL.md': Buffer.from('# Bad') })),
    ).toThrow(/Invalid skill zip path/);
    expect(() =>
      parseSkillZipUpload(
        makeZip({
          'one/SKILL.md': Buffer.from('# One'),
          'two/SKILL.md': Buffer.from('# Two'),
        }),
      ),
    ).toThrow(/one skill root/);
    expect(() =>
      parseSkillZipUpload(
        makeZip(
          { 'skill/SKILL.md': Buffer.from('# Link') },
          { symlinks: new Set(['skill/SKILL.md']) },
        ),
      ),
    ).toThrow(/symlinks/);
    expect(() =>
      parseSkillZipUpload(
        makeZip({ 'SKILL.md': Buffer.alloc(2 * 1024 * 1024 + 1) }),
      ),
    ).toThrow(/too large/);
    expect(() =>
      parseSkillZipUpload(
        makeZip({
          'skill/SKILL.md': Buffer.from('# Skill'),
          'ignored.bin': Buffer.alloc(2 * 1024 * 1024 + 1),
        }),
      ),
    ).toThrow(/one skill root/);
    expect(() =>
      parseSkillZipUpload(
        makeZip(
          Object.fromEntries([
            ['SKILL.md', Buffer.from('# Skill')],
            ...Array.from({ length: 128 }, (_, index) => [
              `file-${index}.txt`,
              Buffer.from('x'),
            ]),
          ]),
        ),
      ),
    ).toThrow(/too many files/);
  });
});

function makeZip(
  files: Record<string, Buffer>,
  options: { symlinks?: Set<string> } = {},
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(content.byteLength, 18);
    local.writeUInt32LE(content.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.byteLength, 20);
    central.writeUInt32LE(content.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(
      options.symlinks?.has(name) ? 0o120000 * 0x10000 : 0,
      38,
    );
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.byteLength + nameBytes.byteLength + content.byteLength;
  }

  const locals = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(central.byteLength, 12);
  eocd.writeUInt32LE(locals.byteLength, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([locals, central, eocd]);
}
