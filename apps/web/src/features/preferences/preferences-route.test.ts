import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

it('keeps the motion control visible, aligned, and singularly labelled', () => {
  const route = readFileSync(
    new URL('./preferences-route.tsx', import.meta.url),
    'utf8',
  );
  const switchSource = readFileSync(
    new URL('../../ui/primitives/switch.tsx', import.meta.url),
    'utf8',
  );

  expect(route).toContain('id="reduce-motion-title"');
  expect(route).toContain('aria-label="Reduce motion"');
  expect(route).not.toContain('<Field');
  expect(switchSource).toContain('data-[state=checked]:bg-status-attention');
  expect(switchSource).toContain('size-4');
  expect(switchSource).toContain('data-[state=checked]:translate-x-3.5');
  expect(switchSource).not.toContain('data-checked:bg-primary');
});
