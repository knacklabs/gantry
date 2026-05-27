import { ShopifyAdapterError } from '../errors.js';
import { getVerifiedIdentity } from '../identity/identity-context.js';
import type { VerifiedIdentity } from '../identity/identity-header.js';
import { customerVerifiedPhoneNotFoundError } from './customer-safe-response.js';
import { normalizeEmail, normalizePhone } from './guard.js';

export interface EffectiveIdentity {
  phone?: string;
  email?: string;
  source: 'header' | 'arg' | 'mixed';
  requireVerifiedIdentity: boolean;
}

export interface ResolveOptions {
  callerPhone?: string;
  callerEmail?: string;
  requireVerifiedIdentity?: boolean;
}

/**
 * Resolves the effective caller identity used by every privacy-guarded tool.
 *
 * Identity axes (phone, email) are equally valid — a customer may have either
 * or both on their Shopify record. Whichever the caller can prove control of
 * is sufficient.
 *
 * Precedence rules — designed to make prompt-injection of identity impossible:
 *
 *   1. In required verified-phone mode, only the trusted header phone is used.
 *      Prompt-supplied phone values that disagree are rejected, and prompt
 *      email cannot expand the customer's authority.
 *   2. In argument mode, a present verified identity header is authoritative
 *      for direct tool harnesses and local tests.
 *   3. With no header, the args become the identity. At least one of phone/email
 *      must be supplied; tools that need identity throw NO_IDENTITY otherwise.
 *
 * Returns the resolved phone/email plus a `source` tag for audit logging.
 */
export function resolveEffectiveIdentity(
  opts: ResolveOptions,
): EffectiveIdentity {
  const header = getVerifiedIdentity();
  const requireVerifiedIdentity = opts.requireVerifiedIdentity ?? false;
  if (requireVerifiedIdentity) {
    return resolveRequiredVerifiedPhoneIdentity(header, opts);
  }
  if (header) {
    enforceHeaderArgConsistency(header, opts);
    return {
      phone: header.phone,
      email: header.email,
      source: opts.callerPhone || opts.callerEmail ? 'mixed' : 'header',
      requireVerifiedIdentity,
    };
  }
  const normalizedPhone = opts.callerPhone
    ? (normalizePhone(opts.callerPhone) ?? undefined)
    : undefined;
  const normalizedEmail = opts.callerEmail
    ? (normalizeEmail(opts.callerEmail) ?? undefined)
    : undefined;
  if (!normalizedPhone && !normalizedEmail) {
    throw new ShopifyAdapterError(
      'PRIVACY_GUARD_FAILED',
      'I need your phone number or email to look this up. Please share the one you used when placing the order.',
      {
        reason: 'NO_IDENTITY',
        dev: 'callerPhone or callerEmail is required when no verified identity header is present',
      },
    );
  }
  return {
    phone: normalizedPhone,
    email: normalizedEmail,
    source: 'arg',
    requireVerifiedIdentity,
  };
}

function resolveRequiredVerifiedPhoneIdentity(
  header: VerifiedIdentity | null,
  args: ResolveOptions,
): EffectiveIdentity {
  const verifiedPhone = header?.phone
    ? (normalizePhone(header.phone) ?? undefined)
    : undefined;
  if (!verifiedPhone) {
    throw customerVerifiedPhoneNotFoundError(
      'VERIFIED_PHONE_UNAVAILABLE',
      'required customer mode has no verified phone in trusted identity context',
    );
  }
  if (args.callerPhone && normalizePhone(args.callerPhone) !== verifiedPhone) {
    throw customerVerifiedPhoneNotFoundError(
      'ARG_VS_HEADER_MISMATCH',
      'callerPhone argument disagrees with the trusted verified phone',
    );
  }
  return {
    phone: verifiedPhone,
    source: args.callerPhone || args.callerEmail ? 'mixed' : 'header',
    requireVerifiedIdentity: true,
  };
}

function enforceHeaderArgConsistency(
  header: VerifiedIdentity,
  args: ResolveOptions,
): void {
  if (args.callerPhone) {
    if (!header.phone) {
      // Header authenticated email but not phone — LLM cannot introduce a
      // phone-axis identity under the header's cover.
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'You can only check details linked to your own phone number.',
        {
          reason: 'ARG_VS_HEADER_MISMATCH',
          dev: 'callerPhone argument was supplied but the channel-verified identity header does not include a phone',
        },
      );
    }
    if (normalizePhone(args.callerPhone) !== normalizePhone(header.phone)) {
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'You can only check details linked to your own phone number.',
        {
          reason: 'ARG_VS_HEADER_MISMATCH',
          dev: 'callerPhone argument disagrees with the channel-verified identity header',
        },
      );
    }
  }
  if (args.callerEmail) {
    if (!header.email) {
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'You can only check details linked to your own account.',
        {
          reason: 'ARG_VS_HEADER_MISMATCH',
          dev: 'callerEmail argument was supplied but the channel-verified identity header does not include an email',
        },
      );
    }
    if (normalizeEmail(args.callerEmail) !== normalizeEmail(header.email)) {
      throw new ShopifyAdapterError(
        'PRIVACY_GUARD_FAILED',
        'You can only check details linked to your own account.',
        {
          reason: 'ARG_VS_HEADER_MISMATCH',
          dev: 'callerEmail argument disagrees with the channel-verified identity header',
        },
      );
    }
  }
}
