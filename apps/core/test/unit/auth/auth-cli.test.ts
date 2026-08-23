import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  approve: vi.fn(),
  confirm: vi.fn(),
  createLocalAuthorizationUrl: vi.fn(),
  ensureSettings: vi.fn(),
  error: vi.fn(),
  fetch: vi.fn(),
  getPending: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
  release: vi.fn(),
  success: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  confirm: mocks.confirm,
  isCancel: mocks.isCancel,
  log: { error: mocks.error, success: mocks.success },
  note: mocks.note,
}));
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  acquireRuntimeStorageForRuntimeHome: mocks.acquire,
}));
vi.mock('@core/config/settings/runtime-settings.js', () => ({
  ensureRuntimeSettings: mocks.ensureSettings,
}));
vi.mock('@core/control/server/routes/browser-auth.js', () => ({
  createLocalAuthorizationUrl: mocks.createLocalAuthorizationUrl,
}));
vi.mock(
  '@core/adapters/storage/postgres/repositories/authentication-repository.postgres.js',
  () => ({
    PostgresAuthenticationRepository: class {
      getAwaitingAccessReference = mocks.getPending;
      approveAccessReference = mocks.approve;
    },
  }),
);

import { hashAuthToken } from '@core/application/auth/auth-foundations.js';
import { runAuthCommand } from '@core/cli/auth-access.js';
import { runUiCommand } from '@core/cli/auth.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValue({ ok: true });
  mocks.ensureSettings.mockReturnValue({
    authentication: {
      mode: 'local',
      canonicalOrigin: 'http://127.0.0.1:3939',
      activeOidc: { companyDomain: 'example.com' },
    },
  });
  mocks.acquire.mockResolvedValue({
    storage: { service: { db: {} } },
    owned: true,
    release: mocks.release,
  });
  mocks.release.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  mocks.createLocalAuthorizationUrl
    .mockResolvedValueOnce('http://127.0.0.1:3939/ui/auth/local#token=one')
    .mockResolvedValueOnce('http://127.0.0.1:3939/ui/auth/local#token=two');
  mocks.getPending.mockResolvedValue({
    appId: 'default',
    userId: 'user-1',
    displayName: 'A User',
    aliases: [
      {
        provider: 'oidc',
        providerAccountId: 'https://issuer.example.com',
        externalUserId: 'subject-not-shown',
        verificationStatus: 'verified',
      },
      {
        provider: 'email',
        providerAccountId: null,
        externalUserId: 'user@example.com',
        verificationStatus: 'verified',
      },
    ],
  });
  mocks.approve.mockResolvedValue({
    appId: 'default',
    userId: 'user-1',
    role: 'administrator',
  });
});

it('authentication CLI > uses one-time local authorization and trusted access approval', async () => {
  const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await expect(runUiCommand('/tmp/gantry', [])).resolves.toBe(0);
  await expect(runUiCommand('/tmp/gantry', ['authorize'])).resolves.toBe(0);
  expect(mocks.createLocalAuthorizationUrl).toHaveBeenCalledTimes(2);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(printed.mock.calls.flat()).toEqual([
    'http://127.0.0.1:3939/ui/auth/local#token=one',
    'http://127.0.0.1:3939/ui/auth/local#token=two',
  ]);

  const reference = 'GNT-0123456789';
  await expect(
    runAuthCommand('/tmp/gantry', [
      'access',
      'approve',
      reference,
      '--role',
      'administrator',
    ]),
  ).resolves.toBe(0);

  const accessReferenceHash = hashAuthToken(reference);
  expect(mocks.getPending).toHaveBeenCalledWith(
    accessReferenceHash,
    expect.any(String),
  );
  expect(mocks.confirm).toHaveBeenCalledWith({
    message: 'Grant administrator console access?',
    initialValue: false,
  });
  expect(mocks.approve).toHaveBeenCalledWith({
    accessReferenceHash,
    role: 'administrator',
    actor: 'cli:auth-access',
    now: expect.any(String),
  });
  expect(mocks.confirm.mock.invocationCallOrder[0]!).toBeLessThan(
    mocks.approve.mock.invocationCallOrder[0]!,
  );
  expect(JSON.stringify(mocks.note.mock.calls)).not.toContain(reference);
  expect(JSON.stringify(mocks.note.mock.calls)).not.toContain(
    'subject-not-shown',
  );
  expect(mocks.release).toHaveBeenCalledTimes(3);
});

it('authentication CLI > refuses to create a local authorization link when Gantry is unavailable', async () => {
  mocks.fetch.mockRejectedValueOnce(new Error('connection refused'));

  await expect(runUiCommand('/tmp/gantry', [])).resolves.toBe(1);

  expect(mocks.error).toHaveBeenCalledWith(
    'Gantry is not running at http://127.0.0.1:3939. Start it with `gantry service start`, then run `gantry ui` again.',
  );
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(mocks.createLocalAuthorizationUrl).not.toHaveBeenCalled();
});
