import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('uses the shared Button and reports clipboard outcomes accessibly', () => {
  const component = readFileSync(
    new URL('./copy-button.tsx', import.meta.url),
    'utf8',
  );

  expect(component).toContain("import { Button } from './button'");
  expect(component).toContain('navigator.clipboard?.writeText');
  expect(component).toContain('role="status"');
  expect(component).toContain("'Copy failed.'");
});
