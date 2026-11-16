import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const braces = require('braces') as { expand(pattern: string): string[] };
const packageMetadata = require('braces/package.json') as {
  name: string;
  version: string;
};

describe('braces security guard', () => {
  it('retains the audited package identity and ordinary expansion behavior', () => {
    expect(packageMetadata).toMatchObject({ name: 'braces', version: '3.0.3' });
    expect(braces.expand('a/{b,c}/d')).toEqual(['a/b/d', 'a/c/d']);
  });

  it('rejects excessive nesting with a controlled error', () => {
    const pattern = `${'{'.repeat(101)}a${'}'.repeat(101)}`;

    expect(() => braces.expand(pattern)).toThrow(
      'Input depth (101), exceeds max depth (100)',
    );
  });
});
