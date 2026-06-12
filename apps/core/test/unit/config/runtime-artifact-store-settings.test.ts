import { describe, expect, it } from 'vitest';

import { parseRuntimeSettings } from '@core/config/settings/runtime-settings-parser.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

const artifactStoreYaml = (body: string): string => `runtime:
  artifact_store:
${body}`;

describe('runtime.artifact_store settings', () => {
  it('defaults the driver to local when the block is absent', () => {
    const parsed = parseRuntimeSettings('agent:\n  name: Gantry\n');
    expect(parsed.runtime.artifactStore.driver).toBe('local');
    expect(parsed.runtime.artifactStore.bucket).toBeUndefined();
  });

  it('parses an explicit s3 driver with required bucket and optional fields', () => {
    const parsed = parseRuntimeSettings(
      artifactStoreYaml(
        [
          '    driver: s3',
          '    bucket: gantry-artifacts',
          '    region: us-east-1',
          '    endpoint: http://minio:9000',
          '    force_path_style: true',
        ].join('\n'),
      ),
    );
    expect(parsed.runtime.artifactStore).toEqual({
      driver: 's3',
      bucket: 'gantry-artifacts',
      region: 'us-east-1',
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
    });
  });

  it('requires a bucket when the driver is s3', () => {
    expect(() =>
      parseRuntimeSettings(artifactStoreYaml('    driver: s3')),
    ).toThrow(/runtime.artifact_store.bucket must be a non-empty string/);
  });

  it('rejects an unknown driver via the strict parser', () => {
    expect(() =>
      parseRuntimeSettings(artifactStoreYaml('    driver: gcs')),
    ).toThrow(/runtime.artifact_store.driver must be local or s3/);
  });

  it('rejects unknown keys inside the artifact_store block', () => {
    expect(() =>
      parseRuntimeSettings(
        artifactStoreYaml('    driver: s3\n    bucket: b\n    prefix: skills'),
      ),
    ).toThrow(/runtime.artifact_store.prefix is not supported/);
  });

  it('rejects s3-only fields when the driver is local', () => {
    expect(() =>
      parseRuntimeSettings(
        artifactStoreYaml('    driver: local\n    bucket: b'),
      ),
    ).toThrow(/bucket is only supported when driver is s3/);
  });

  it('rejects an unknown key under runtime', () => {
    expect(() =>
      parseRuntimeSettings('runtime:\n  artifacts:\n    driver: s3\n'),
    ).toThrow(/runtime.artifacts is not supported/);
  });

  it('renders an s3 artifact store block and round-trips through the parser', () => {
    const settings = createDefaultRuntimeSettings();
    settings.runtime.artifactStore = {
      driver: 's3',
      bucket: 'gantry-artifacts',
      region: 'us-east-1',
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
    };
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).toContain('  artifact_store:');
    expect(yaml).toContain('    driver: s3');
    expect(yaml).toContain('    bucket: gantry-artifacts');
    expect(yaml).toContain('    endpoint: "http://minio:9000"');
    expect(yaml).toContain('    force_path_style: true');

    const parsed = parseRuntimeSettings(yaml);
    expect(parsed.runtime.artifactStore).toEqual(
      settings.runtime.artifactStore,
    );
  });

  it('omits the artifact_store block for the default local driver to avoid drift', () => {
    const settings = createDefaultRuntimeSettings();
    const yaml = renderRuntimeSettingsYaml(settings);
    expect(yaml).not.toContain('artifact_store:');
  });
});
