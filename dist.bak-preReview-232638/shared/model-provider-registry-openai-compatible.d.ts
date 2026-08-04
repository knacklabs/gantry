import type { ModelCredentialPayload, ModelProviderCacheSupport, ModelProviderDefinition } from './model-provider-registry.js';
import type { ModelWorkload } from './model-catalog.js';
declare function resolveBedrockUpstream(input: {
    authMode: string;
    payload: ModelCredentialPayload;
}): {
    origin: string;
    pathPrefix: string;
};
declare function resolveVertexUpstream(input: {
    payload: ModelCredentialPayload;
}): {
    origin: string;
    pathPrefix: string;
};
export declare const OPENAI_COMPATIBLE_PROVIDER_DEFINITIONS: readonly [ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, {
    readonly id: "bedrock";
    readonly label: "Amazon Bedrock";
    readonly executable: true;
    readonly modelRoute: true;
    readonly embeddingProvider: false;
    readonly responseFamily: string;
    readonly supportedWorkloads: readonly ModelWorkload[];
    readonly credentialModes: readonly [{
        readonly id: "aws_default_chain";
        readonly label: "AWS role or profile";
        readonly helpText: "Use the host AWS credential chain for SigV4 Bedrock Chat Completions. In production, prefer an ECS task role, EC2 instance profile, EKS IRSA, or assumed role.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "region";
            readonly label: "AWS region";
            readonly secret: false;
            readonly required: true;
        }, {
            readonly name: "profile";
            readonly label: "AWS profile (optional)";
            readonly secret: false;
            readonly required: false;
        }];
        readonly gatewayAuth: {
            readonly strategy: "aws_sdk_default_chain";
        };
    }, {
        readonly id: "bedrock_api_key_ref";
        readonly label: "Bedrock API key in AWS Secrets Manager";
        readonly helpText: "Resolve an Amazon Bedrock API key from AWS Secrets Manager at gateway time.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "region";
            readonly label: "AWS region";
            readonly secret: false;
            readonly required: true;
        }, {
            readonly name: "apiKeyRef";
            readonly label: "AWS Secrets Manager ref (aws-sm:...)";
            readonly secret: false;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "aws_bedrock_api_key_ref";
            readonly field: "apiKeyRef";
        };
    }, {
        readonly id: "bedrock_api_key";
        readonly label: "Bedrock API key";
        readonly helpText: "Use an Amazon Bedrock API key for OpenAI-compatible chat completions.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "region";
            readonly label: "AWS region";
            readonly secret: false;
            readonly required: true;
        }, {
            readonly name: "apiKey";
            readonly label: "Bedrock API key";
            readonly secret: true;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "aws_bedrock_api_key";
            readonly field: "apiKey";
        };
    }];
    readonly gateway: {
        readonly pathSegment: "bedrock";
        readonly upstreamOrigin: "https://bedrock-mantle.us-east-1.api.aws";
        readonly upstreamPathPrefix: "/v1";
        readonly upstreamResolver: typeof resolveBedrockUpstream;
        readonly sdkProjection: {
            readonly baseUrlEnv: "OPENAI_BASE_URL";
            readonly tokenEnv: "OPENAI_API_KEY";
            readonly credentialProviderEnvKey: "OPENAI_API_KEY";
            readonly credentialProvider: string;
        };
    };
    readonly cacheSupport: ModelProviderCacheSupport;
    readonly executionRoute: {
        readonly engine: "deepagents";
        readonly executionProviderId: "deepagents:langchain";
        readonly supportedCredentialModes: readonly string[];
    };
}, {
    readonly id: "vertex";
    readonly label: "Google Vertex AI";
    readonly executable: true;
    readonly modelRoute: true;
    readonly embeddingProvider: false;
    readonly responseFamily: string;
    readonly supportedWorkloads: readonly ModelWorkload[];
    readonly credentialModes: readonly [{
        readonly id: "google_adc";
        readonly label: "Google ADC or workload identity";
        readonly helpText: "Use Google Application Default Credentials to mint a host-side OAuth token for Vertex AI.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "region";
            readonly label: "Google Cloud location (currently global)";
            readonly secret: false;
            readonly required: true;
        }, {
            readonly name: "projectId";
            readonly label: "Google Cloud project ID";
            readonly secret: false;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "google_adc";
        };
    }, {
        readonly id: "service_account_ref";
        readonly label: "Service account JSON in Google Secret Manager";
        readonly helpText: "Resolve a Google service account JSON key from Google Secret Manager at gateway time.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "region";
            readonly label: "Google Cloud location (currently global)";
            readonly secret: false;
            readonly required: true;
        }, {
            readonly name: "projectId";
            readonly label: "Google Cloud project ID";
            readonly secret: false;
            readonly required: true;
        }, {
            readonly name: "serviceAccountJsonRef";
            readonly label: "Google Secret Manager ref (gcp-sm:...)";
            readonly secret: false;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "vertex_service_account_ref";
            readonly field: "serviceAccountJsonRef";
        };
    }, {
        readonly id: "service_account";
        readonly label: "Service account";
        readonly helpText: "Use a Google Cloud service account JSON key for OpenAI-compatible chat completions.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "region";
            readonly label: "Google Cloud location (currently global)";
            readonly secret: false;
            readonly required: true;
        }, {
            readonly name: "projectId";
            readonly label: "Google Cloud project ID";
            readonly secret: false;
            readonly required: true;
        }, {
            readonly name: "serviceAccountJson";
            readonly label: "Service account JSON";
            readonly secret: true;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "vertex_service_account";
            readonly field: "serviceAccountJson";
        };
    }];
    readonly gateway: {
        readonly pathSegment: "vertex";
        readonly upstreamOrigin: "https://aiplatform.googleapis.com";
        readonly upstreamPathPrefix: `/v1/projects/example-project/locations/global/endpoints/${string}`;
        readonly upstreamResolver: typeof resolveVertexUpstream;
        readonly sdkProjection: {
            readonly baseUrlEnv: "OPENAI_BASE_URL";
            readonly tokenEnv: "OPENAI_API_KEY";
            readonly credentialProviderEnvKey: "OPENAI_API_KEY";
            readonly credentialProvider: string;
        };
    };
    readonly cacheSupport: ModelProviderCacheSupport;
    readonly executionRoute: {
        readonly engine: "deepagents";
        readonly executionProviderId: "deepagents:langchain";
        readonly supportedCredentialModes: readonly string[];
    };
}];
export {};
