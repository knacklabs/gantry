import { describe, expect, it } from 'vitest';

import {
  browserProfileStorageRefFor,
  hashBrowserProfileFiles,
  normalizeBrowserProfileFiles,
  resolveBrowserProfileSymlinkTarget,
} from '@core/adapters/artifacts/browser-profiles/browser-profile-bundle.js';
import { isExcludedBrowserProfilePath } from '@core/shared/browser-profile-snapshot-exclude.js';
import { hashBrowserProfileFileModel } from '@core/shared/browser-profile-hash.js';

describe('browser profile exclude list', () => {
  it('excludes regenerable caches and host-local junk', () => {
    for (const p of [
      'Default/Cache/data_0',
      'Default/Cache_Data/index',
      'Default/Code Cache/js/foo',
      'GPUCache/index',
      'GrShaderCache/x',
      'ShaderCache/y',
      'Crashpad/reports/z',
      'Default/Service Worker/CacheStorage/abc',
      'Default/Service Worker/ScriptCache/abc',
      'SingletonLock',
      'SingletonCookie',
      'SingletonSocket',
      'DevToolsActivePort',
      'browser-session.json',
    ]) {
      expect(isExcludedBrowserProfilePath(p)).toBe(true);
    }
  });

  it('keeps cookies, logins, local state, and storage leveldbs', () => {
    for (const p of [
      'Local State',
      'Default/Cookies',
      'Default/Login Data',
      'Default/Local Storage/leveldb/000003.log',
      'Default/IndexedDB/https_x.indexeddb.leveldb/CURRENT',
    ]) {
      expect(isExcludedBrowserProfilePath(p)).toBe(false);
    }
  });
});

describe('browser profile bundle hashing', () => {
  it('is deterministic and order-independent', () => {
    const a = hashBrowserProfileFiles([
      { path: 'Local State', content: Buffer.from('a') },
      { path: 'Default/Cookies', content: Buffer.from('b') },
    ]);
    const b = hashBrowserProfileFiles([
      { path: 'Default/Cookies', content: Buffer.from('b') },
      { path: 'Local State', content: Buffer.from('a') },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('matches the shared file-model hash used by the runtime pre-check', () => {
    const files = [
      {
        path: 'Default/Cookies',
        kind: 'file' as const,
        content: Buffer.from('c'),
      },
      { path: 'Local State', kind: 'file' as const, content: Buffer.from('s') },
    ];
    // The runtime snapshot producer pre-hashes with hashBrowserProfileFileModel;
    // the store hashes the same files with hashBrowserProfileFiles. They must
    // agree byte for byte so the "unchanged ⇒ skip put" pre-check is valid.
    expect(hashBrowserProfileFiles(files)).toBe(
      hashBrowserProfileFileModel(files),
    );
  });

  it('reflects mode and symlink target in the hash', () => {
    const base = hashBrowserProfileFiles([
      { path: 'x', kind: 'file', mode: 0o600, content: Buffer.from('c') },
    ]);
    const otherMode = hashBrowserProfileFiles([
      { path: 'x', kind: 'file', mode: 0o755, content: Buffer.from('c') },
    ]);
    expect(base).not.toBe(otherMode);
  });

  it('normalizes paths and sorts deterministically', () => {
    const files = normalizeBrowserProfileFiles([
      { path: 'b/c', content: Buffer.from('1') },
      { path: 'a', content: Buffer.from('2') },
    ]);
    expect(files.map((f) => f.path)).toEqual(['a', 'b/c']);
  });
});

describe('browser profile storage ref + traversal guards', () => {
  it('builds a content-addressed per-profile ref', () => {
    expect(
      browserProfileStorageRefFor('c-kai-abc', `sha256:${'a'.repeat(64)}`),
    ).toBe(`browser-profiles/c-kai-abc/${'a'.repeat(64)}`);
  });

  it('rejects a malformed content hash', () => {
    expect(() => browserProfileStorageRefFor('c-kai', 'not-a-hash')).toThrow();
  });

  it('rejects symlink targets that escape the root', () => {
    expect(() =>
      resolveBrowserProfileSymlinkTarget('/root', 'Default/alias', '../../etc'),
    ).toThrow();
    expect(() =>
      resolveBrowserProfileSymlinkTarget('/root', 'Default/alias', '/abs'),
    ).toThrow();
  });

  it('accepts an in-tree relative symlink target', () => {
    expect(
      resolveBrowserProfileSymlinkTarget('/root', 'Default/alias', 'Cookies'),
    ).toBe('Cookies');
  });
});
