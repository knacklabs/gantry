import type { RuntimeArtifactStoreSettings } from './runtime-settings-types.js';
/**
 * Render the `runtime.artifact_store` block. The default `local` driver renders
 * nothing (callers omit the whole runtime block when everything is default);
 * the `s3` driver renders its required bucket and any optional connection
 * fields. Secrets are never rendered — credentials resolve through the AWS SDK
 * credential chain, not settings.
 */
export declare function renderArtifactStoreYamlLines(store: RuntimeArtifactStoreSettings): string[];
