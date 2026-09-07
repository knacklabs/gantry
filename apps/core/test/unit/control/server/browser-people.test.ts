import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import { isBrowserPeoplePath } from '@core/control/server/routes/browser-people.js';

const repoRoot = path.resolve(
  new URL('../../../../../..', import.meta.url).pathname,
);
const source = fs.readFileSync(
  path.join(repoRoot, 'apps/core/src/control/server/routes/browser-people.ts'),
  'utf8',
);

it('exposes a session-bound, alias-safe People directory', () => {
  expect(isBrowserPeoplePath('/ui/api/people')).toBe(true);
  expect(isBrowserPeoplePath('/ui/api/people/person-1')).toBe(false);
  expect(source).toContain('activeSession(req, settings.authentication.mode)');
  expect(source).toContain("'people:read'");
  expect(source).toContain('new PersonIdentityService');
  expect(source).toContain('verificationStatus: alias.verificationStatus');
  expect(source).not.toContain('externalUserId: alias.externalUserId');
});
