import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const reference = readFileSync(
  new URL(
    '../../../docs/reference/onboarding/gantry-onboarding-v2.dc.html',
    import.meta.url,
  ),
);
const visualContract = readFileSync(
  new URL(
    '../../../docs/specs/v2-first-agent-onboarding-visual-contract.md',
    import.meta.url,
  ),
  'utf8',
);
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const entrypoint = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

it('matches the immutable V2 reference outside documented masks at all required viewports', () => {
  expect(createHash('sha256').update(reference).digest('hex')).toBe(
    'c1dc1305abd4876f74ac7b0c8e097205c891b3478fb3ab7f7db1ec6f72259a45',
  );
  for (const viewport of [
    '1920×956',
    '1469×800',
    '1280×800',
    '1024×768',
    '768×1024',
    '375×812',
  ]) {
    expect(visualContract).toContain(viewport);
  }
  expect(visualContract).toContain('zero unexpected changed pixels');
  expect(visualContract).toContain('Deliberate deviations from the prototype');
  expect(entrypoint).toContain('@fontsource-variable/dm-sans');
  expect(entrypoint).toContain('@fontsource-variable/schibsted-grotesk');
  expect(entrypoint).toContain('@fontsource/dm-mono/400.css');
  expect(styles).toContain('--font-display:');
  expect(styles).toContain('@keyframes onboarding-splash-role-roll');
  expect(styles).toContain("[data-motion='reduced']");
  expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  expect(styles).toContain('@media (min-width: 768px)');
});
