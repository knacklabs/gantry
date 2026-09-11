import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the V2 splash assets, copy, and motion contract', () => {
  const route = readFileSync(
    'src/features/onboarding/onboarding-route.tsx',
    'utf8',
  );
  const styles = readFileSync('src/styles.css', 'utf8');
  const assets = readFileSync('src/assets/onboarding/index.ts', 'utf8');
  const mark = readFileSync(
    'src/assets/onboarding/gantry-splash-mark.svg',
    'utf8',
  );
  const knacklabs = readFileSync(
    'src/assets/onboarding/knacklabs-mark.svg',
    'utf8',
  );
  const entrypoint = readFileSync('src/main.tsx', 'utf8');

  expect(assets).toContain('gantry-splash-mark.svg');
  expect(assets).toContain('knacklabs-mark.svg');
  expect(mark.match(/<rect/g)).toHaveLength(9);
  expect(mark).toContain('animation: reveal .5s');
  expect(mark).toContain('green-glow');
  expect(knacklabs).toContain('viewBox="0 0 24 24"');
  expect(route).toContain("'HR assistant'");
  expect(route).toContain("'executive assistant'");
  expect(route).toContain('Set Up Your First Agent');
  expect(route).toContain('Hire your first employee');
  expect(route).toContain('Powered by');
  expect(styles).toContain('onboarding-splash-role-roll 16.8s');
  expect(styles).toContain('transform: translateY(-11.4em)');
  expect(styles).toContain(":root[data-motion='reduced']");
  expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  expect(styles).not.toContain('fonts.googleapis.com');
  expect(entrypoint).toContain('@fontsource-variable/dm-sans');
  expect(entrypoint).toContain('@fontsource/dm-mono/500.css');
  expect(entrypoint).toContain('@fontsource-variable/schibsted-grotesk');
});
