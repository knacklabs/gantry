import type { RuntimeArtifactStoreSettings } from './runtime-settings-types.js';
import { quoteYamlString } from './yaml.js';

/**
 * Render the `runtime.artifact_store` block. The default `local` driver renders
 * nothing (callers omit the whole runtime block when everything is default);
 * the `s3` driver renders its required bucket and any optional connection
 * fields. Secrets are never rendered — credentials resolve through the AWS SDK
 * credential chain, not settings.
 */
export function renderArtifactStoreYamlLines(
  store: RuntimeArtifactStoreSettings,
): string[] {
  if (store.driver !== 's3') return [];
  return [
    '  artifact_store:',
    `    driver: ${quoteYamlString(store.driver)}`,
    ...(store.bucket !== undefined
      ? [`    bucket: ${quoteYamlString(store.bucket)}`]
      : []),
    ...(store.region !== undefined
      ? [`    region: ${quoteYamlString(store.region)}`]
      : []),
    ...(store.endpoint !== undefined
      ? [`    endpoint: ${quoteYamlString(store.endpoint)}`]
      : []),
    ...(store.forcePathStyle !== undefined
      ? [`    force_path_style: ${store.forcePathStyle ? 'true' : 'false'}`]
      : []),
  ];
}
