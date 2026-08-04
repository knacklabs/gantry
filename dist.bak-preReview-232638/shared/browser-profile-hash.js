import { createHash } from 'node:crypto';
/**
 * Shared normalize + content-hash for browser profile snapshot file sets. Both
 * the runtime snapshot producer (cheap "unchanged hash ⇒ skip put" pre-check)
 * and the adapter store/materializer use this so the pre-check hash is byte-for-
 * byte identical to the stored content hash. Same
 * `sha256(path \0 kind \0 mode \0 linkTarget \0 content \0 ...)` shape as the
 * toolchain/skill artifacts.
 */
export function normalizeBrowserProfileFileModel(files) {
    return files
        .map((file) => ({
        path: file.path.replace(/\\/g, '/'),
        kind: file.kind ?? 'file',
        content: new Uint8Array(file.content),
        mode: (file.kind ?? 'file') === 'file' ? (file.mode ?? 0o600) : undefined,
        linkTarget: file.linkTarget,
    }))
        .sort((left, right) => left.path.localeCompare(right.path));
}
export function hashBrowserProfileFileModel(files) {
    const hash = createHash('sha256');
    for (const file of normalizeBrowserProfileFileModel(files)) {
        hash.update(file.path);
        hash.update('\0');
        hash.update(file.kind ?? 'file');
        hash.update('\0');
        hash.update(String(file.mode ?? ''));
        hash.update('\0');
        hash.update(file.linkTarget ?? '');
        hash.update('\0');
        hash.update(file.content);
        hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
}
