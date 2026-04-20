import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServicePath } from '@core/platform/service-path.js';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe('buildServicePath', () => {
  it('returns only absolute trusted entries', () => {
    process.env.PATH = './bin:../tmp:~/hack:/tmp/custom';
    const servicePath = buildServicePath('/home/tester');
    const entries = servicePath.split(path.delimiter).filter(Boolean);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => path.isAbsolute(entry))).toBe(true);
    expect(entries).toContain(path.dirname(process.execPath));
    expect(entries.some((entry) => entry.includes('./bin'))).toBe(false);
    expect(entries.some((entry) => entry.includes('../tmp'))).toBe(false);
    expect(entries.some((entry) => entry.includes('~/hack'))).toBe(false);
  });
});
