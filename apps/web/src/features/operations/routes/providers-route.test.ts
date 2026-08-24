import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps provider status and actions specific', () => {
  const route = readFileSync(
    'src/features/operations/routes/providers-route.tsx',
    'utf8',
  );
  const dialogs = readFileSync(
    'src/features/operations/routes/provider-dialogs.tsx',
    'utf8',
  );

  expect(route).not.toContain('Add provider');
  expect(route).not.toContain('CornerDownLeft');
  expect(route).toContain("{ label: 'Configured', value: 'ready' }");
  expect(route).toContain("{ label: 'Not configured', value: 'attention' }");
  expect(dialogs).toContain("label: 'Required'");
  expect(dialogs).toContain("label: 'Not configured'");
  expect(dialogs).toContain("label: 'Configured'");
  expect(dialogs).toContain('<TooltipContent side="top" sideOffset={6}>');
  expect(dialogs).toContain('Add credential');
  expect(dialogs).toContain('Manage credential');
  expect(dialogs).toContain("? 'Re-enable'");
  expect(dialogs).toContain('Disable provider');
  expect(dialogs).toContain('Gantry will not use it');
  expect(dialogs).toContain('aria-live="polite"');
});
