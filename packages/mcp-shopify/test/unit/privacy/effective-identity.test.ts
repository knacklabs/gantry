import { describe, expect, it } from 'vitest';
import { runWithIdentity } from '../../../src/identity/identity-context.js';
import { resolveEffectiveIdentity } from '../../../src/privacy/effective-identity.js';
import { ShopifyAdapterError } from '../../../src/errors.js';

describe('resolveEffectiveIdentity', () => {
  it('uses arg values when no header is present', () => {
    const id = resolveEffectiveIdentity({
      callerPhone: '+91-98765-43210',
      callerEmail: 'A@B.com',
    });
    expect(id).toMatchObject({
      phone: '+919876543210',
      email: 'a@b.com',
      source: 'arg',
    });
  });

  it('throws NO_IDENTITY when no header and no args', () => {
    const err = (() => {
      try {
        resolveEffectiveIdentity({});
        return null;
      } catch (e) {
        return e as ShopifyAdapterError;
      }
    })();
    expect(err).toBeInstanceOf(ShopifyAdapterError);
    expect(err?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((err?.details as { reason: string }).reason).toBe('NO_IDENTITY');
  });

  it('uses header values when present', async () => {
    const id = await runWithIdentity(
      {
        phone: '+919876543210',
        email: 'aanya@example.com',
        issuedAtMs: Date.now(),
      },
      async () => resolveEffectiveIdentity({}),
    );
    expect(id).toMatchObject({
      phone: '+919876543210',
      email: 'aanya@example.com',
      source: 'header',
    });
  });

  it('rejects when callerPhone arg disagrees with header phone (ARG_VS_HEADER_MISMATCH)', async () => {
    const err = await runWithIdentity(
      { phone: '+919876543210', issuedAtMs: Date.now() },
      async () => {
        try {
          resolveEffectiveIdentity({ callerPhone: '+919999999999' });
          return null;
        } catch (e) {
          return e as ShopifyAdapterError;
        }
      },
    );
    expect(err?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((err?.details as { reason: string }).reason).toBe(
      'ARG_VS_HEADER_MISMATCH',
    );
  });

  it('rejects when callerEmail arg disagrees with header email', async () => {
    const err = await runWithIdentity(
      { email: 'verified@example.com', issuedAtMs: Date.now() },
      async () => {
        try {
          resolveEffectiveIdentity({ callerEmail: 'other@example.com' });
          return null;
        } catch (e) {
          return e as ShopifyAdapterError;
        }
      },
    );
    expect(err?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((err?.details as { reason: string }).reason).toBe(
      'ARG_VS_HEADER_MISMATCH',
    );
  });

  it('rejects when LLM tries to introduce a phone the header did not authenticate', async () => {
    // Header carries email only — LLM attempts to add a phone-axis identity.
    // Without this check, the attacker could inject an arbitrary phone alongside
    // the verified email.
    const err = await runWithIdentity(
      { email: 'verified@example.com', issuedAtMs: Date.now() },
      async () => {
        try {
          resolveEffectiveIdentity({ callerPhone: '+919876543210' });
          return null;
        } catch (e) {
          return e as ShopifyAdapterError;
        }
      },
    );
    expect(err?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((err?.details as { reason: string }).reason).toBe(
      'ARG_VS_HEADER_MISMATCH',
    );
  });

  it('rejects when LLM tries to introduce an email the header did not authenticate', async () => {
    // Header carries phone only — LLM attempts to add an email-axis identity.
    // This was the original C1 critical from the PR review.
    const err = await runWithIdentity(
      { phone: '+919876543210', issuedAtMs: Date.now() },
      async () => {
        try {
          resolveEffectiveIdentity({ callerEmail: 'attacker@example.com' });
          return null;
        } catch (e) {
          return e as ShopifyAdapterError;
        }
      },
    );
    expect(err?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((err?.details as { reason: string }).reason).toBe(
      'ARG_VS_HEADER_MISMATCH',
    );
  });

  it('accepts matching arg + header (source=mixed)', async () => {
    const id = await runWithIdentity(
      { phone: '+919876543210', issuedAtMs: Date.now() },
      async () => resolveEffectiveIdentity({ callerPhone: '+91-98765-43210' }),
    );
    expect(id.source).toBe('mixed');
    expect(id.phone).toBe('+919876543210');
  });
});
