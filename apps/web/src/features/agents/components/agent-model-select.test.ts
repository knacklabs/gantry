import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('shows model providers separately and explains unavailable credentials', () => {
  const picker = readFileSync(
    'src/features/agents/components/agent-model-select.tsx',
    'utf8',
  );
  expect(picker).toContain('Model provider');
  expect(picker).toContain('model.providerId === next && model.configured');
  expect(picker).toContain('disabled={!model.configured}');
  expect(picker).toContain('Configure model providers');
  expect(picker).toContain('onValueChange(null)');
});
