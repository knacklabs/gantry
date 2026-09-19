import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const boundary = readFileSync('src/app/critical-error-boundary.tsx', 'utf8');
const main = readFileSync('src/main.tsx', 'utf8');
const router = readFileSync('src/app/router.tsx', 'utf8');

describe('critical error recovery', () => {
  it('installs root and route error boundaries at their intended levels', () => {
    expect(main).toContain('<CriticalErrorBoundary>');
    expect(main).toMatch(/<CriticalErrorBoundary>\s*<App \/>/);
    expect(router).toContain('defaultErrorComponent: RouteErrorPage');
  });

  it('provides accessible recovery actions without exposing the error', () => {
    expect(boundary).toContain('role="alert"');
    expect(boundary).toContain('aria-labelledby="critical-error-heading"');
    expect(boundary).toContain('headingRef.current?.focus()');
    expect(boundary).toContain('tabIndex={-1}');
    expect(boundary).toContain('Gantry stopped unexpectedly');
    expect(boundary).toContain('This view could not load');
    expect(boundary).toContain('Reload console');
    expect(boundary).toContain('Reload view');
    expect(boundary).toContain('Back to Overview');
    expect(boundary).toContain('window.location.reload()');
    expect(boundary).toContain('onReload={reset}');
    expect(boundary).toContain('href={overviewHref}');
    expect(boundary).not.toMatch(/error\.(message|stack)/);
  });

  it('keeps the root fallback independent from app providers and the router', () => {
    expect(boundary).not.toContain('useRouter');
    expect(boundary).not.toContain('Provider');
    expect(boundary).not.toContain('<Link');
    expect(boundary).toContain('import.meta.env.BASE_URL');
    expect(boundary).toContain('min-h-dvh');
    expect(boundary).toContain('flex-col gap-2 sm:flex-row');
  });
});
