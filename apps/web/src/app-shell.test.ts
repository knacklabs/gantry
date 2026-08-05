import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('web shell boundary', () => {
  it('renders_not_connected_shell_with_persisted_preferences', () => {
    const source = readFileSync('src/app/app.tsx', 'utf8');

    expect(source).toContain('ConnectionGateProvider');
    expect(source).not.toContain(['/', 'ui-api'].join(''));
  });

  it('keeps_the_preview_tablet_and_desktop_only', () => {
    const source = readFileSync('src/app/app-shell.tsx', 'utf8');

    expect(source).toContain('Tablet or desktop required');
    expect(source).toContain('md:grid');
    expect(source).toContain('md:hidden');
  });
});
