/**
 * Minimal browser profile file-model shape this hash needs. Defined locally in
 * the shared layer (which may not import domain ports) and kept structurally
 * compatible with the domain `BrowserProfileArtifactFile`.
 */
export interface BrowserProfileFileModel {
    path: string;
    kind?: 'file' | 'symlink';
    content: Uint8Array;
    mode?: number;
    linkTarget?: string;
}
/**
 * Shared normalize + content-hash for browser profile snapshot file sets. Both
 * the runtime snapshot producer (cheap "unchanged hash ⇒ skip put" pre-check)
 * and the adapter store/materializer use this so the pre-check hash is byte-for-
 * byte identical to the stored content hash. Same
 * `sha256(path \0 kind \0 mode \0 linkTarget \0 content \0 ...)` shape as the
 * toolchain/skill artifacts.
 */
export declare function normalizeBrowserProfileFileModel<T extends BrowserProfileFileModel>(files: T[]): BrowserProfileFileModel[];
export declare function hashBrowserProfileFileModel(files: BrowserProfileFileModel[]): string;
