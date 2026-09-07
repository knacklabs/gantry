import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { isBrowserChannelAccountsPath } from '@core/control/server/routes/browser-channel-accounts.js';

const repoRoot = path.resolve(
  new URL('../../../../../..', import.meta.url).pathname,
);
const source = fs.readFileSync(
  path.join(
    repoRoot,
    'apps/core/src/control/server/routes/browser-channel-accounts.ts',
  ),
  'utf8',
);

it('exposes session-bound channel account reads and guarded write-only creation', () => {
  expect(isBrowserChannelAccountsPath('/ui/api/channel-providers')).toBe(true);
  expect(isBrowserChannelAccountsPath('/ui/api/channel-accounts')).toBe(true);
  expect(isBrowserChannelAccountsPath('/ui/api/conversations')).toBe(true);
  expect(
    isBrowserChannelAccountsPath(
      '/ui/api/agents/agent%3Aone/conversation-installs',
    ),
  ).toBe(true);
  expect(isBrowserChannelAccountsPath('/ui/api/channel-accounts/one')).toBe(
    false,
  );
  expect(source).toContain('activeSession(req, settings.authentication.mode)');
  expect(source).toContain("'providers:read'");
  expect(source).toContain("'conversations:read'");
  expect(source).toContain("'agents:admin'");
  expect(source).toContain("'providers:admin'");
  expect(source).toContain('requireBrowserMutationSession');
  expect(source).toContain('isCanonicalBrowserOrigin');
  expect(source).toContain('isRecentlyReauthenticated');
  expect(source).toContain('new CapabilitySecretService');
  expect(source).toContain('gantryRuntimeSecretRef(name)');
  expect(source).toContain(
    'credentialKeys: Object.keys(account.runtimeSecretRefs)',
  );
  expect(source).not.toContain('runtimeSecretRefs: account.runtimeSecretRefs');
  expect(source).not.toContain('authorizeControlRequest(');
});
