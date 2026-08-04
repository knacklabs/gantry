import { describe, expect, it } from 'vitest';

import {
  hashSkillBundle,
  normalizeSkillBundle,
} from '@core/shared/skill-artifact-helpers.js';

describe('skill artifact helpers', () => {
  it('distinguishes bundles that collided under NUL-delimited framing', () => {
    const nul = Buffer.from([0]);
    const embeddedFraming = Buffer.concat([
      Buffer.from('first'),
      nul,
      Buffer.from('z.txt'),
      nul,
      Buffer.from('second'),
    ]);
    const oldSingleAssetFraming = Buffer.concat([
      Buffer.from('SKILL.md'),
      nul,
      embeddedFraming,
      nul,
    ]);
    const oldTwoAssetFraming = Buffer.concat([
      Buffer.from('SKILL.md'),
      nul,
      Buffer.from('first'),
      nul,
      Buffer.from('z.txt'),
      nul,
      Buffer.from('second'),
      nul,
    ]);

    expect(oldSingleAssetFraming).toEqual(oldTwoAssetFraming);

    const singleAssetHash = hashSkillBundle({
      assets: [{ path: 'SKILL.md', content: embeddedFraming }],
    });
    const twoAssetHash = hashSkillBundle({
      assets: [
        { path: 'SKILL.md', content: Buffer.from('first') },
        { path: 'z.txt', content: Buffer.from('second') },
      ],
    });

    expect(singleAssetHash).not.toBe(twoAssetHash);
  });

  it('rejects duplicate paths after normalization', () => {
    expect(() =>
      normalizeSkillBundle({
        assets: [
          { path: 'SKILL.md', content: Buffer.from('# Skill') },
          { path: 'docs/info.md', content: Buffer.from('first') },
          { path: 'docs\\info.md', content: Buffer.from('second') },
        ],
      }),
    ).toThrow('Duplicate skill asset path after normalization: docs/info.md');
  });
});
