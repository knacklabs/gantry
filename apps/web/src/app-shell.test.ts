import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('web shell boundary', () => {
  it('renders_not_connected_shell_with_persisted_preferences', () => {
    const source = readFileSync('apps/web/src/app/app.tsx', 'utf8');

    expect(source).toContain('ConnectionGateProvider');
    expect(source).not.toContain(['/', 'ui-api'].join(''));
  });
});
