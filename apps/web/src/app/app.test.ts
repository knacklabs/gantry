import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('mounts one globally themed Sonner host at the root', () => {
  const app = readFileSync(new URL('./app.tsx', import.meta.url), 'utf8');

  expect(app).toContain("import { Toaster } from 'sonner';");
  expect(app.match(/<Toaster/g)).toHaveLength(1);
  expect(app).toContain('position="bottom-right"');
  expect(app).toContain('duration={4_000}');
  expect(app).toContain('theme={effectiveTheme}');
  expect(app).toContain('bg-surface');
  expect(app).toContain('text-text');
  expect(app).toContain('border-status-success');
  expect(app).toContain('border-danger');
  expect(app).toContain('motion-reduce:transition-none');
});
