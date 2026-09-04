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
  const app = readFileSync('src/app/app.tsx', 'utf8');

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
  expect(dialogs).toContain('Remove credential…');
  expect(dialogs).toContain('Type {provider?.label} to confirm');
  expect(dialogs).toContain('/credential');
  expect(dialogs).toContain('Gantry will not use it');
  expect(dialogs).toContain('Authentication method');
  expect(dialogs).toContain('Choose an authentication method to continue.');
  expect(dialogs).toContain("method: isSameMode ? 'PATCH' : 'PUT'");
  expect(dialogs).toContain('Changing methods replaces the stored credential.');
  expect(dialogs).toContain('<Textarea');
  expect(dialogs).toContain("' (stored)'");
  expect(dialogs).toContain('Check configuration');
  expect(dialogs).not.toContain('Verify credential');
  expect(dialogs).toContain('aria-live="polite"');
  expect(app).toContain('<TooltipProvider>');
});
