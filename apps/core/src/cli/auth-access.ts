import * as p from '@clack/prompts';

import { hashAuthToken } from '../application/auth/auth-foundations.js';
import { PostgresAuthenticationRepository } from '../adapters/storage/postgres/repositories/authentication-repository.postgres.js';
import { acquireRuntimeStorageForRuntimeHome } from '../adapters/storage/postgres/runtime-store.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { nowIso } from '../shared/time/datetime.js';

const ACCESS_REFERENCE_PATTERN = /^GNT-[0-9A-F]{10}$/;

function usage(): string {
  return 'Usage: gantry auth access approve <reference> --role administrator|viewer';
}

function safeOperatorText(
  value: string | null | undefined,
  fallback: string,
): string {
  return (value?.replace(/\p{Cc}/gu, ' ').trim() || fallback).slice(0, 200);
}

export async function runAuthCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [area, action, reference, roleFlag, role, ...extra] = args;
  if (
    area !== 'access' ||
    action !== 'approve' ||
    !reference ||
    !ACCESS_REFERENCE_PATTERN.test(reference) ||
    roleFlag !== '--role' ||
    (role !== 'administrator' && role !== 'viewer') ||
    extra.length > 0
  ) {
    console.log(usage());
    return 1;
  }
  const settings = ensureRuntimeSettings(runtimeHome);
  let release: (() => Promise<void>) | undefined;
  try {
    const lease = await acquireRuntimeStorageForRuntimeHome(
      runtimeHome,
      settings,
    );
    release = lease.release;
    const storage = lease.storage;
    const repo = new PostgresAuthenticationRepository(storage.service.db);
    const accessReferenceHash = hashAuthToken(reference);
    const pending = await repo.getAwaitingAccessReference(
      accessReferenceHash,
      nowIso(),
    );
    if (!pending) {
      p.log.error('The access reference is invalid or has expired.');
      return 1;
    }
    const oidc = pending.aliases.find((alias) => alias.provider === 'oidc');
    const email = pending.aliases.find(
      (alias) =>
        alias.provider === 'email' && alias.verificationStatus === 'verified',
    );
    const companyDomain = settings.authentication.activeOidc?.companyDomain;
    p.note(
      [
        `Person: ${safeOperatorText(pending.displayName, pending.userId)}`,
        `Issuer: ${safeOperatorText(oidc?.providerAccountId, 'unknown')}`,
        `Verified email: ${safeOperatorText(email?.externalUserId, 'none')}`,
        `Company-domain match: ${
          companyDomain && email?.externalUserId.endsWith(`@${companyDomain}`)
            ? 'yes'
            : 'no'
        }`,
        `Requested role: ${role}`,
        `App: ${safeOperatorText(pending.appId, 'unknown')}`,
      ].join('\n'),
      'Approve console access',
    );
    const confirmed = await p.confirm({
      message: `Grant ${role} console access?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) return 1;
    const approved = await repo.approveAccessReference({
      accessReferenceHash,
      role,
      actor: 'cli:auth-access',
      now: nowIso(),
    });
    if (!approved) {
      p.log.error('The access reference is invalid or has expired.');
      return 1;
    }
    p.log.success(
      role === 'administrator'
        ? 'Administrator access granted.'
        : 'Viewer access granted.',
    );
    return 0;
  } catch {
    p.log.error(
      'Console access could not be approved. Check Gantry storage and try again.',
    );
    return 1;
  } finally {
    await release?.().catch(() => undefined);
  }
}
