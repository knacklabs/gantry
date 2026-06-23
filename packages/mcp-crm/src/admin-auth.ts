import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

export type AdminRole = 'super_admin' | 'admin' | 'viewer';
export type AdminStatus = 'active' | 'disabled';

const ADMIN_ROLES = new Set<AdminRole>(['super_admin', 'admin', 'viewer']);
const ADMIN_STATUSES = new Set<AdminStatus>(['active', 'disabled']);

const SCRYPT_KEYLEN = 64;

export function normalizeAdminEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Invalid admin email.');
  }
  return normalized;
}

export function parseAdminRole(input: unknown): AdminRole {
  if (typeof input === 'string' && ADMIN_ROLES.has(input as AdminRole)) {
    return input as AdminRole;
  }
  throw new Error('Invalid admin role.');
}

export function parseAdminStatus(input: unknown): AdminStatus {
  if (typeof input === 'string' && ADMIN_STATUSES.has(input as AdminStatus)) {
    return input as AdminStatus;
  }
  throw new Error('Invalid admin status.');
}

export function assertValidPassword(password: string): string {
  if (password.length < 4) {
    throw new Error('Password must be at least 4 characters.');
  }
  if (password.length > 256) {
    throw new Error('Password must be 256 characters or fewer.');
  }
  return password;
}

export async function hashAdminPassword(password: string): Promise<string> {
  const checked = assertValidPassword(password);
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = (await scryptAsync(checked, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt$${salt}$${key.toString('base64url')}`;
}

export async function verifyAdminPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [scheme, salt, encoded] = storedHash.split('$');
  if (scheme !== 'scrypt' || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'base64url');
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
