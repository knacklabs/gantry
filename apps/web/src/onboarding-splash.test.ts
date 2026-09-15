import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the V2 splash assets, copy, and motion contract', () => {
  const splash = readFileSync(
    new URL('./features/onboarding/onboarding-splash.tsx', import.meta.url),
    'utf8',
  );
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const assets = readFileSync(
    new URL('./assets/onboarding/index.ts', import.meta.url),
    'utf8',
  );
  const mark = readFileSync(
    new URL('./assets/onboarding/gantry-splash-mark.svg', import.meta.url),
    'utf8',
  );
  const knacklabs = readFileSync(
    new URL('./assets/onboarding/knacklabs-mark.svg', import.meta.url),
    'utf8',
  );
  const entrypoint = readFileSync(
    new URL('./main.tsx', import.meta.url),
    'utf8',
  );

  expect(assets).toContain('gantry-splash-mark.svg');
  expect(assets).toContain('knacklabs-mark.svg');
  expect(mark.match(/<rect/g)).toHaveLength(9);
  expect(mark).toContain('animation: reveal .5s');
  expect(mark).toContain('green-glow');
  expect(knacklabs).toContain('viewBox="0 0 24 24"');
  expect(splash).toContain("'HR assistant'");
  expect(splash).toContain("'executive assistant'");
  expect(splash).toContain('Set Up Your First Agent');
  expect(splash).toContain('Hire your first employee');
  expect(splash).not.toContain('Give it a name');
  expect(splash).not.toContain('Job title');
  expect(splash).not.toContain('onName');
  expect(splash).not.toContain('onTitle');
  expect(splash).toContain('Powered by');
  expect(styles).toContain('onboarding-splash-role-roll 16.8s');
  expect(styles).toContain('transform: translateY(-11.4em)');
  expect(styles).toContain(":root[data-motion='reduced']");
  expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  expect(styles).not.toContain('fonts.googleapis.com');
  expect(entrypoint).toContain('@fontsource-variable/dm-sans');
  expect(entrypoint).toContain('@fontsource/dm-mono/500.css');
  expect(entrypoint).toContain('@fontsource-variable/schibsted-grotesk');
});
