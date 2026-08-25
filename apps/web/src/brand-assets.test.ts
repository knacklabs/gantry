import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('renders canonical Gantry brand assets', () => {
  const mark = readFileSync('public/brand/gantry-mark.svg', 'utf8');
  const favicon = readFileSync('public/favicon.svg', 'utf8');
  const touchIcon = readFileSync('public/apple-touch-icon.png');
  const index = readFileSync('index.html', 'utf8');
  const navigation = readFileSync('src/app/app-navigation.tsx', 'utf8');
  const authCard = readFileSync('src/features/auth/auth-card.tsx', 'utf8');
  const component = readFileSync('src/ui/compositions/gantry-mark.tsx', 'utf8');
  const styles = readFileSync('src/styles.css', 'utf8');

  expect(mark).toContain('viewBox="0 0 24 24"');
  expect(mark.match(/<rect /g)).toHaveLength(4);
  expect(mark).toContain('x="1" y="16" width="7" height="7"');
  expect(mark).toContain('x="8.5" y="8.5" width="7" height="7"');
  expect(mark).toContain('x="16" y="16" width="7" height="7"');
  expect(mark).toContain('x="16" y="1" width="7" height="7"');
  expect(mark).not.toContain('<text');
  expect(favicon).toContain('#1B1A18');
  expect(favicon).toContain('#F7F6F4');
  expect(touchIcon.readUInt32BE(16)).toBe(180);
  expect(touchIcon.readUInt32BE(20)).toBe(180);
  expect(index).toContain('href="/ui/favicon.svg"');
  expect(index).toContain('href="/ui/apple-touch-icon.png"');
  expect(index).not.toContain('data:image/svg+xml');
  expect(component).toContain('import.meta.env.BASE_URL');
  expect(component).toContain('maskImage');
  expect(component).toContain('aria-hidden="true"');
  expect(navigation).toContain('<GantryMark className="size-6 text-ink" />');
  expect(navigation).toContain('font-[Arial,sans-serif]');
  expect(authCard).toContain(
    '<GantryMark className="size-7 text-[#c0985f]" />',
  );
  expect(styles).not.toContain('auth-page-mark');
});
