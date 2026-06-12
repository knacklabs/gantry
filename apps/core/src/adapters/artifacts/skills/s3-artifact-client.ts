import { S3Client } from '@aws-sdk/client-s3';

export interface S3ArtifactClientConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

/**
 * Build an S3 client for the artifact store. Credentials are NOT settings:
 * they resolve through the AWS SDK default credential chain (IAM role on the
 * fleet; standard `AWS_*` env or shared config locally). Endpoint/bucket/region
 * are non-secret config injected from `runtime.artifact_store`. MinIO is
 * supported via a custom `endpoint` + `forcePathStyle: true`.
 */
export function createS3ArtifactClient(config: S3ArtifactClientConfig): {
  client: S3Client;
  bucket: string;
} {
  if (!config.bucket.trim()) {
    throw new Error(
      'runtime.artifact_store.bucket is required when driver is s3',
    );
  }
  const client = new S3Client({
    ...(config.region ? { region: config.region } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle !== undefined
      ? { forcePathStyle: config.forcePathStyle }
      : {}),
  });
  return { client, bucket: config.bucket };
}
