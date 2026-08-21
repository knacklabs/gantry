import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the approved public copy and removes fragment credentials', () => {
  const source = readFileSync('src/features/auth/auth-pages.tsx', 'utf8');
  const server = readFileSync(
    '../core/src/control/server/routes/browser-auth.ts',
    'utf8',
  );
  const rootRoute = readFileSync('src/app/root-route.tsx', 'utf8');
  const styles = readFileSync('src/styles.css', 'utf8');

  expect(source.match(/history\.replaceState/g)).toHaveLength(2);
  expect(source.indexOf('history.replaceState')).toBeLessThan(
    source.indexOf("fetch('/auth/local/authorize'"),
  );
  expect(source.lastIndexOf('history.replaceState')).toBeLessThan(
    source.indexOf("fetch('/auth/invitations/start'"),
  );
  expect(source).toContain('This browser is authorized.');
  expect(source).toContain(
    'This authorization link has expired. Run `gantry ui authorize` to create a new one.',
  );
  expect(server).toContain('This authorization link has already been used.');
  expect(source).toContain('Sign in with Google');
  expect(source).toContain('You do not have access to this Gantry console.');
  expect(source).toContain('Your Gantry console access has been disabled.');
  expect(source).toContain(
    'Sign-in could not be completed. Start again from Gantry.',
  );
  expect(source).toContain('Test sign-in configuration');
  expect(source).toContain('Sign in again to continue.');
  expect(source).toContain('This invitation has already been used.');
  expect(source).toContain(
    'This invitation has expired. Ask an administrator for a new one.',
  );
  expect(source).toContain('auth-page-shell');
  expect(source).toContain('auth-page-signal');
  expect(source).toContain('auth-google-sign-in-button');
  expect(source).toContain('auth-page-action');
  expect(source).toContain('auth-page-reference');
  expect(source).toContain('!overflow-visible');
  expect(source).toContain('!rounded-none');
  expect(source).toContain('CircleAlert');
  expect(source).toContain('Secure console access.');
  expect(source).toContain('Access is managed.');
  expect(source).toContain('Preparing your console');
  expect(source).toContain('Checking your session.');
  expect(rootRoute).toContain('beforeLoad: async');
  expect(rootRoute).toContain("throw redirect({ to: '/auth/sign-in' })");
  expect(rootRoute).toContain('pendingComponent: AuthLoadingPage');
  expect(styles).toContain('minmax(min(100%, 30rem), 1fr)');
});

it('keeps access changes explicit and restores focus to receipts', () => {
  const source = readFileSync(
    'src/features/auth/authentication-access-route.tsx',
    'utf8',
  );
  const server = readFileSync(
    '../core/src/control/server/routes/browser-auth.ts',
    'utf8',
  );

  expect(source).toContain('Create invitation');
  expect(server).toContain(
    'Invitation created. This link can be used once and expires in 7 days.',
  );
  expect(source).toContain('REAUTHENTICATION_REQUIRED');
  expect(source).toContain('receiptRef.current?.focus()');
  expect(source).toContain('window.requestAnimationFrame');
  expect(source).toContain('body: JSON.stringify(change)');
  expect(server).toContain('At least one active Administrator is required.');
  expect(source).toContain('/ui/api/auth/sessions');
  expect(source).toContain('/ui/api/auth/invitations');
  expect(source).toContain('This browser');
  expect(source).toContain('Viewer access is read-only.');
  expect(source).toContain('configuration-tested');
  expect(source).toContain('configuration-test-failed');
  expect(source).toContain('window.location.assign(body.redirectUrl)');
  expect(source).toContain(
    'Sign-in configuration verified. Activate it for this deployment?',
  );
});
