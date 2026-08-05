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

  it('uses_a_non_modal_alert_for_the_connection_gate', () => {
    const source = readFileSync(
      'src/ui/compositions/connection-gate.tsx',
      'utf8',
    );

    expect(source).toContain('<Alert');
    expect(source).toContain('AlertAction');
    expect(source).toContain('useContext');
    expect(source).toContain('useMemo');
    expect(source).not.toContain('primitives/dialog');
  });
});
