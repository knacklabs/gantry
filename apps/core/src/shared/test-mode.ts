// DEV/TESTING ONLY. Scopes test behaviour (the Shopify caller-identity override
// and outbound dry-run) to a single operator conversation, so those flags are
// safe to enable on a server that also receives real traffic: only the
// operator's own number is affected; every other caller behaves normally.
//
// Set GANTRY_TEST_OPERATOR_PHONE (in $GANTRY_HOME/.env or the process env) to the
// operator's digits (e.g. 919654405340). If it is unset, test mode is UNSCOPED
// (applies to all callers) — only do that on a fully isolated dev instance.
//
// `shared` may not import `config`, so this reads process.env (the value is
// hydrated from .env at startup; see app/index.ts -> hydrateDynamicRuntimeEnv).
const OPERATOR_ENV = 'GANTRY_TEST_OPERATOR_PHONE';

export function testOperatorPhone(): string | undefined {
  return process.env[OPERATOR_ENV]?.trim() || undefined;
}

export function jidInTestScope(jid: string): boolean {
  const operator = testOperatorPhone();
  if (!operator) return true;
  // Strip the channel prefix (e.g. "wa:") to compare the dialled digits.
  return jid.replace(/^\D*/, '') === operator;
}

// DEV/TESTING ONLY. True only when GANTRY_TEST_OPERATOR_PHONE is set AND `jid`
// is that operator's own conversation. Lets the test operator reset their own
// session (/new) and run other session commands without being a production
// control approver — so the scenario harness can isolate each run. Unlike
// jidInTestScope, this is STRICT: with the operator unset it always returns
// false, so it is a hard no-op in production (where the flag is never set).
export function isTestOperatorJid(jid: string): boolean {
  const operator = testOperatorPhone();
  if (!operator) return false;
  return jid.replace(/^\D*/, '') === operator;
}
