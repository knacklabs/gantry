import { jidInTestScope } from '../../shared/test-mode.js';

// DEV/TESTING ONLY. When GANTRY_TEST_CALLER_IDENTITY_PHONE is set, the MCP
// caller identity (the JID used to sign the X-Caller-Identity header) is remapped
// to that phone, so Shopify queries resolve against a test customer that actually
// has data — while WhatsApp/conversation routing keeps the real number.
//
// Safety: applied ONLY where the MCP caller identity is derived, and ONLY for the
// configured operator conversation (jidInTestScope) so real customers keep their
// own identity. Outbound replies use the untouched conversation JID, so a reply
// can never be delivered to the test number. Unset in production => no-op.
const TEST_PHONE_ENV = 'GANTRY_TEST_CALLER_IDENTITY_PHONE';

export function applyTestCallerIdentityOverride(jid: string): string {
  const testPhone = process.env[TEST_PHONE_ENV]?.trim();
  if (!testPhone) return jid;
  if (!jidInTestScope(jid)) return jid;
  // Preserve the channel prefix (e.g. "wa:") and swap only the numeric suffix.
  const match = jid.match(/^(.*?)(\d+)$/);
  return match ? `${match[1]}${testPhone}` : jid;
}
