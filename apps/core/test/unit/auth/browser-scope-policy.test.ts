import { expect, it } from 'vitest';

import {
  BROWSER_SCOPE_POLICY,
  assertBrowserScopePolicyExhaustive,
  browserRoleAllowsScope,
} from '@core/control/server/browser-scope-policy.js';
import { CONTROL_API_SCOPES } from '@core/shared/control-api-keys.js';

it('browser scope policy > classifies every Control scope and keeps Viewer read-only', () => {
  expect(() => assertBrowserScopePolicyExhaustive()).not.toThrow();
  expect(Object.keys(BROWSER_SCOPE_POLICY).sort()).toEqual(
    [...CONTROL_API_SCOPES].sort(),
  );
  expect(new Set(Object.values(BROWSER_SCOPE_POLICY))).toEqual(
    new Set(['administrator', 'viewer_read', 'browser_ineligible']),
  );

  for (const scope of CONTROL_API_SCOPES) {
    const policy = BROWSER_SCOPE_POLICY[scope];
    expect(browserRoleAllowsScope('viewer', scope)).toBe(
      policy === 'viewer_read',
    );
    expect(browserRoleAllowsScope('administrator', scope)).toBe(
      policy !== 'browser_ineligible',
    );
    if (policy === 'viewer_read') expect(scope.endsWith(':read')).toBe(true);
  }
});
