import { describe, expect, it } from 'vitest';

import {
  hashAdminPassword,
  verifyAdminPassword,
  normalizeAdminEmail,
  parseAdminRole,
  parseAdminStatus,
} from '../src/admin-auth.js';

describe('admin auth helpers', () => {
  it('normalizes admin emails', () => {
    expect(normalizeAdminEmail(' Owner@Boondi.Local ')).toBe(
      'owner@boondi.local',
    );
  });

  it('hashes and verifies passwords without storing plaintext', async () => {
    const hash = await hashAdminPassword('correct horse battery staple');

    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain('correct horse battery staple');
    await expect(
      verifyAdminPassword('correct horse battery staple', hash),
    ).resolves.toBe(true);
    await expect(verifyAdminPassword('wrong password', hash)).resolves.toBe(
      false,
    );
  });

  it('accepts four character bootstrap passwords', async () => {
    const hash = await hashAdminPassword('1234');

    await expect(verifyAdminPassword('1234', hash)).resolves.toBe(true);
  });

  it('rejects passwords shorter than four characters', async () => {
    await expect(hashAdminPassword('123')).rejects.toThrow(
      'Password must be at least 4 characters.',
    );
  });

  it('accepts only known roles and statuses', () => {
    expect(parseAdminRole('super_admin')).toBe('super_admin');
    expect(parseAdminRole('admin')).toBe('admin');
    expect(parseAdminRole('viewer')).toBe('viewer');
    expect(() => parseAdminRole('owner')).toThrow(/role/i);

    expect(parseAdminStatus('active')).toBe('active');
    expect(parseAdminStatus('disabled')).toBe('disabled');
    expect(() => parseAdminStatus('deleted')).toThrow(/status/i);
  });
});
