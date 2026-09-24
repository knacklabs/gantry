import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('does not constrain popper option lists to the trigger height', () => {
  const source = readFileSync('src/ui/primitives/select.tsx', 'utf8');
  expect(source).toContain('data-[position=popper]:min-h-(--radix-select-trigger-height)');
  expect(source).not.toContain('data-[position=popper]:h-(--radix-select-trigger-height)');
});
