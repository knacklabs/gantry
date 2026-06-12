/**
 * A browser profile snapshot is the whole Chrome `user-data/` tree MINUS caches
 * and host-local transient junk. Partial cookie-only restores risk profile
 * corruption (Chrome cross-references Cookies / Local State / Login Data), so
 * the snapshot contract is full-minus-cache rather than a curated subset.
 *
 * This predicate is the single source of truth for what the snapshot producer
 * (runtime walker over the live `user-data/` dir) drops. The artifact store
 * re-reads an already-curated snapshot, so it does NOT re-filter.
 *
 * Excluded (relative to `user-data/`):
 *  - Regenerable caches: any directory segment named `Cache`/`Cache*`,
 *    `Code Cache`, `GPUCache`, `GrShaderCache`, `ShaderCache`, `CacheStorage`,
 *    `ScriptCache`, `component_crx_cache` (covers top-level and per-profile
 *    `Default/Cache`, `Default/Code Cache`,
 *    `Default/Service Worker/CacheStorage`, etc.).
 *  - Crash telemetry: `Crashpad`.
 *  - Host-local singleton/lock + devtools port files: `SingletonLock`,
 *    `SingletonCookie`, `SingletonSocket`, `DevToolsActivePort`.
 *  - Gantry host-local session marker: `browser-session.json`.
 * `profile.json` / `profile.lock` live OUTSIDE `user-data/` so they are never
 * part of the snapshot tree.
 */
const EXCLUDED_PATH_SEGMENTS = new Set<string>([
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
  'CacheStorage',
  'ScriptCache',
  'component_crx_cache',
]);

const EXCLUDED_EXACT_PATHS = new Set<string>([
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'DevToolsActivePort',
  'browser-session.json',
]);

export function isExcludedBrowserProfilePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (EXCLUDED_EXACT_PATHS.has(normalized)) return true;
  const segments = normalized.split('/');
  if (segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) {
    return true;
  }
  // `Cache`, `Cache_Data`, etc. — Chrome suffixes the per-profile cache dir.
  // Drop any segment that starts with `Cache` under any directory.
  return segments.some((segment) => /^Cache(\b|_|$)/.test(segment));
}
