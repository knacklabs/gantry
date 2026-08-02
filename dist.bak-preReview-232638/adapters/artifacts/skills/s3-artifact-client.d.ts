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
export declare function createS3ArtifactClient(config: S3ArtifactClientConfig): {
    client: S3Client;
    bucket: string;
};
