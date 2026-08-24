import {
  CONTROL_API_SCOPES,
  type Scope,
} from '../../shared/control-api-keys.js';
import type { ConsoleRole } from '../../application/auth/auth-foundations.js';

export type BrowserScopePolicy =
  | 'administrator'
  | 'viewer_read'
  | 'browser_ineligible';

/**
 * Browser auth is deliberately separate from machine Bearer scopes. Keeping
 * this exhaustive makes every newly added scope an explicit browser decision.
 */
export const BROWSER_SCOPE_POLICY = {
  'sessions:read': 'viewer_read',
  'sessions:write': 'administrator',
  'approvals:write': 'browser_ineligible',
  'jobs:read': 'viewer_read',
  'jobs:write': 'administrator',
  'providers:read': 'viewer_read',
  'providers:admin': 'administrator',
  'conversations:read': 'viewer_read',
  'conversations:admin': 'administrator',
  'messages:read': 'viewer_read',
  'agents:admin': 'administrator',
  'credentials:read': 'viewer_read',
  'credentials:admin': 'administrator',
  'skills:read': 'viewer_read',
  'skills:admin': 'administrator',
  'mcp:read': 'viewer_read',
  'mcp:admin': 'administrator',
  'webhooks:read': 'browser_ineligible',
  'webhooks:write': 'browser_ineligible',
  'ingresses:read': 'browser_ineligible',
  'ingresses:write': 'browser_ineligible',
  'usage:read': 'viewer_read',
  'llm:invoke': 'browser_ineligible',
  'memory:read': 'viewer_read',
  'memory:admin': 'administrator',
  'identity:resolve': 'browser_ineligible',
  'people:read': 'viewer_read',
  'people:admin': 'administrator',
} as const satisfies Record<Scope, BrowserScopePolicy>;

export function browserRoleAllowsScope(
  role: ConsoleRole,
  scope: Scope,
): boolean {
  const policy = BROWSER_SCOPE_POLICY[scope];
  return (
    policy === 'viewer_read' ||
    (policy === 'administrator' && role === 'administrator')
  );
}

export function assertBrowserScopePolicyExhaustive(): void {
  if (Object.keys(BROWSER_SCOPE_POLICY).length !== CONTROL_API_SCOPES.length) {
    throw new Error(
      'Every Control scope must have a browser authorization policy.',
    );
  }
}
