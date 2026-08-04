import type { ModelExecutionProviderId, ModelResponseFamily, ModelWorkload } from './model-catalog.js';
import { type AgentEngine } from './agent-engine.js';
export type ModelCredentialPayload = Record<string, string>;
export interface ModelCredentialFieldDefinition {
    name: string;
    label: string;
    secret: boolean;
    required: boolean;
}
export type ModelGatewayAuthStrategy = 'bearer' | 'header' | 'claude_code_oauth' | 'aws_bedrock_api_key' | 'aws_bedrock_api_key_ref' | 'aws_sigv4' | 'aws_sdk_default_chain' | 'vertex_service_account' | 'vertex_service_account_ref' | 'google_adc' | 'azure_api_key' | 'azure_entra_default_credential';
export interface ModelGatewayAuthDefinition {
    strategy: ModelGatewayAuthStrategy;
    field?: string;
    headerName?: string;
}
export interface ModelCredentialModeDefinition {
    id: string;
    label: string;
    helpText: string;
    version: number;
    fields: readonly ModelCredentialFieldDefinition[];
    gatewayAuth: ModelGatewayAuthDefinition;
}
export interface ModelGatewaySdkProjectionDefinition {
    baseUrlEnv: string;
    tokenEnv: string;
    additionalTokenEnv?: string;
    credentialProviderEnvKey: string;
    credentialProvider: string;
}
export interface ModelGatewayResolvedUpstream {
    origin: string;
    pathPrefix: string;
}
export interface ModelGatewayUpstreamResolverInput {
    authMode: string;
    payload: ModelCredentialPayload;
}
export interface ModelGatewayDefinition {
    pathSegment: string;
    upstreamOrigin: string;
    upstreamPathPrefix: string;
    upstreamResolver?: (input: ModelGatewayUpstreamResolverInput) => ModelGatewayResolvedUpstream;
    sdkProjection: ModelGatewaySdkProjectionDefinition;
}
export type ModelProviderPromptCacheMode = 'none' | 'anthropic_cache_control' | 'openai_automatic_prefix' | 'openrouter_automatic_prefix';
export type ModelProviderResponseCacheMode = 'none' | 'openrouter_response_cache';
export interface ModelProviderCacheUsageFields {
    readTokens?: string;
    writeTokens?: string;
    responseHeaders?: readonly string[];
}
export interface ModelProviderPromptCacheSupport {
    mode: ModelProviderPromptCacheMode;
    automatic: boolean;
    promptCacheKey?: boolean;
    requestControl: 'none' | 'cache_control_blocks' | 'provider_automatic_prefix';
    ttlOptions: readonly string[];
    minimumTokenThresholds: readonly {
        modelFamily: string;
        tokens: number;
    }[];
    usageFields: ModelProviderCacheUsageFields;
}
export interface ModelProviderResponseCacheSupport {
    mode: ModelProviderResponseCacheMode;
    enabledByDefault: boolean;
    requestControl: 'none' | 'request_header';
    requestHeaders: readonly string[];
    responseHeaders: readonly string[];
    usageBehavior: 'normal_usage' | 'zero_usage_on_hit';
}
export interface ModelProviderCacheSupport {
    prompt: ModelProviderPromptCacheSupport;
    response: ModelProviderResponseCacheSupport;
}
export interface ModelExecutionRoute {
    engine: AgentEngine;
    executionProviderId: ModelExecutionProviderId;
    supportedCredentialModes: readonly string[];
}
export interface ModelProviderDefinition {
    id: string;
    label: string;
    executable: boolean;
    modelRoute: boolean;
    embeddingProvider: boolean;
    batch?: {
        supportedCredentialModes: readonly string[];
    };
    responseFamily: ModelResponseFamily;
    supportedWorkloads: readonly ModelWorkload[];
    credentialModes: readonly ModelCredentialModeDefinition[];
    gateway: ModelGatewayDefinition;
    cacheSupport: ModelProviderCacheSupport;
    executionRoute: ModelExecutionRoute;
    sdkModelCapabilityMetadata?: boolean;
    supportsReasoningEffort?: boolean;
}
export declare const MODEL_PROVIDER_DEFINITIONS: readonly [{
    readonly id: "anthropic";
    readonly label: "Anthropic";
    readonly executable: true;
    readonly modelRoute: true;
    readonly embeddingProvider: false;
    readonly batch: {
        readonly supportedCredentialModes: readonly ["api_key"];
    };
    readonly responseFamily: "anthropic";
    readonly supportedWorkloads: readonly ["chat", "one_time_job", "recurring_job", "memory_extractor", "memory_dreaming", "memory_consolidation"];
    readonly credentialModes: readonly [{
        readonly id: "api_key";
        readonly label: "API key";
        readonly helpText: "Use an Anthropic account key for direct Anthropic access.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "apiKey";
            readonly label: "Anthropic key";
            readonly secret: true;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "header";
            readonly field: "apiKey";
            readonly headerName: "x-api-key";
        };
    }, {
        readonly id: "claude_code_oauth";
        readonly label: "Claude Code OAuth";
        readonly helpText: "Use a Claude Code OAuth token. Gantry stores it and uses it only inside the Model Gateway.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "oauthToken";
            readonly label: "Claude Code OAuth token";
            readonly secret: true;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "claude_code_oauth";
            readonly field: "oauthToken";
        };
    }];
    readonly gateway: {
        readonly pathSegment: "anthropic";
        readonly upstreamOrigin: "https://api.anthropic.com";
        readonly upstreamPathPrefix: "";
        readonly sdkProjection: {
            readonly baseUrlEnv: "ANTHROPIC_BASE_URL";
            readonly tokenEnv: "ANTHROPIC_API_KEY";
            readonly credentialProviderEnvKey: "ANTHROPIC_API_KEY";
            readonly credentialProvider: "native";
        };
    };
    readonly cacheSupport: {
        readonly prompt: {
            readonly mode: "anthropic_cache_control";
            readonly automatic: false;
            readonly requestControl: "cache_control_blocks";
            readonly ttlOptions: readonly ["5m", "1h"];
            readonly minimumTokenThresholds: readonly [{
                readonly modelFamily: "claude-opus-4.6+";
                readonly tokens: 4096;
            }, {
                readonly modelFamily: "claude-sonnet-4.6";
                readonly tokens: 2048;
            }, {
                readonly modelFamily: "claude-haiku-4.5";
                readonly tokens: 4096;
            }];
            readonly usageFields: {
                readonly readTokens: "cache_read_input_tokens";
                readonly writeTokens: "cache_creation_input_tokens";
            };
        };
        readonly response: {
            readonly mode: "none";
            readonly enabledByDefault: false;
            readonly requestControl: "none";
            readonly requestHeaders: readonly [];
            readonly responseHeaders: readonly [];
            readonly usageBehavior: "normal_usage";
        };
    };
    readonly executionRoute: {
        readonly engine: "anthropic_sdk";
        readonly executionProviderId: "anthropic:claude-agent-sdk";
        readonly supportedCredentialModes: readonly ["api_key", "claude_code_oauth"];
    };
    readonly sdkModelCapabilityMetadata: true;
}, {
    readonly id: "openrouter";
    readonly label: "OpenRouter";
    readonly executable: true;
    readonly modelRoute: true;
    readonly embeddingProvider: false;
    readonly responseFamily: "anthropic";
    readonly supportedWorkloads: readonly ["chat", "one_time_job", "recurring_job", "memory_extractor", "memory_dreaming", "memory_consolidation"];
    readonly credentialModes: readonly [{
        readonly id: "api_key";
        readonly label: "API key";
        readonly helpText: "Use an OpenRouter key for Anthropic-compatible routing.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "apiKey";
            readonly label: "OpenRouter key";
            readonly secret: true;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "bearer";
            readonly field: "apiKey";
        };
    }];
    readonly gateway: {
        readonly pathSegment: "openrouter";
        readonly upstreamOrigin: "https://openrouter.ai";
        readonly upstreamPathPrefix: "/api";
        readonly sdkProjection: {
            readonly baseUrlEnv: "OPENAI_BASE_URL";
            readonly tokenEnv: "OPENAI_API_KEY";
            readonly credentialProviderEnvKey: "OPENAI_API_KEY";
            readonly credentialProvider: "openrouter";
        };
    };
    readonly cacheSupport: {
        readonly prompt: {
            readonly mode: "openrouter_automatic_prefix";
            readonly automatic: true;
            readonly requestControl: "provider_automatic_prefix";
            readonly ttlOptions: readonly ["5m", "1h"];
            readonly minimumTokenThresholds: readonly [{
                readonly modelFamily: "anthropic-compatible";
                readonly tokens: 2048;
            }];
            readonly usageFields: {
                readonly readTokens: "prompt_tokens_details.cached_tokens";
                readonly writeTokens: "prompt_tokens_details.cache_write_tokens";
            };
        };
        readonly response: {
            readonly mode: "openrouter_response_cache";
            readonly enabledByDefault: false;
            readonly requestControl: "request_header";
            readonly requestHeaders: readonly ["X-OpenRouter-Cache", "X-OpenRouter-Cache-TTL", "X-OpenRouter-Cache-Clear"];
            readonly responseHeaders: readonly ["X-OpenRouter-Cache-Status", "X-OpenRouter-Cache-Age", "X-OpenRouter-Cache-TTL"];
            readonly usageBehavior: "zero_usage_on_hit";
        };
    };
    readonly executionRoute: {
        readonly engine: "deepagents";
        readonly executionProviderId: "deepagents:langchain";
        readonly supportedCredentialModes: readonly ["api_key"];
    };
    readonly supportsReasoningEffort: true;
}, {
    readonly id: "openai";
    readonly label: "OpenAI";
    readonly executable: true;
    readonly modelRoute: true;
    readonly embeddingProvider: true;
    readonly batch: {
        readonly supportedCredentialModes: readonly ["api_key"];
    };
    readonly responseFamily: "openai";
    readonly supportedWorkloads: readonly ["chat", "memory_extractor", "memory_dreaming", "memory_consolidation"];
    readonly credentialModes: readonly [{
        readonly id: "api_key";
        readonly label: "API key";
        readonly helpText: "Use an OpenAI account key for OpenAI API access.";
        readonly version: 1;
        readonly fields: readonly [{
            readonly name: "apiKey";
            readonly label: "OpenAI key";
            readonly secret: true;
            readonly required: true;
        }];
        readonly gatewayAuth: {
            readonly strategy: "bearer";
            readonly field: "apiKey";
        };
    }];
    readonly gateway: {
        readonly pathSegment: "openai";
        readonly upstreamOrigin: "https://api.openai.com";
        readonly upstreamPathPrefix: "";
        readonly sdkProjection: {
            readonly baseUrlEnv: "OPENAI_BASE_URL";
            readonly tokenEnv: "OPENAI_API_KEY";
            readonly credentialProviderEnvKey: "OPENAI_API_KEY";
            readonly credentialProvider: "native";
        };
    };
    readonly cacheSupport: {
        readonly prompt: {
            readonly mode: "openai_automatic_prefix";
            readonly automatic: true;
            readonly requestControl: "provider_automatic_prefix";
            readonly ttlOptions: readonly [];
            readonly minimumTokenThresholds: readonly [{
                readonly modelFamily: "openai";
                readonly tokens: 1024;
            }];
            readonly usageFields: {
                readonly readTokens: "prompt_tokens_details.cached_tokens";
            };
        };
        readonly response: {
            readonly mode: "none";
            readonly enabledByDefault: false;
            readonly requestControl: "none";
            readonly requestHeaders: readonly [];
            readonly responseHeaders: readonly [];
            readonly usageBehavior: "normal_usage";
        };
    };
    readonly executionRoute: {
        readonly engine: "deepagents";
        readonly executionProviderId: "deepagents:langchain";
        readonly supportedCredentialModes: readonly ["api_key"];
    };
    readonly supportsReasoningEffort: true;
}, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, ModelProviderDefinition, {
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
        readonly upstreamResolver: (input: {
            authMode: string;
            payload: ModelCredentialPayload;
        }) => {
            origin: string;
            pathPrefix: string;
        };
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
        readonly upstreamResolver: (input: {
            payload: ModelCredentialPayload;
        }) => {
            origin: string;
            pathPrefix: string;
        };
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
export type ModelProviderId = (typeof MODEL_PROVIDER_DEFINITIONS)[number]['id'];
export type ModelRouteProviderId = Extract<(typeof MODEL_PROVIDER_DEFINITIONS)[number], {
    modelRoute: true;
}>['id'];
export declare function listModelProviderDefinitions(): readonly ModelProviderDefinition[];
export declare function listExecutableModelProviders(): readonly ModelProviderDefinition[];
export declare function listModelRouteProviders(): readonly ModelProviderDefinition[];
export declare function getDefaultModelRouteProvider(): ModelProviderDefinition | undefined;
export declare function listEmbeddingModelProviders(): readonly ModelProviderDefinition[];
export declare function getDefaultEmbeddingModelProvider(): ModelProviderDefinition | undefined;
export declare function getModelProviderDefinition(providerId: string): ModelProviderDefinition | undefined;
export declare function getModelProviderByGatewayPath(pathSegment: string): ModelProviderDefinition | undefined;
export declare function normalizeModelProviderId(providerId: string): ModelProviderId;
export declare function normalizeModelRouteProviderId(providerId: string): ModelRouteProviderId;
export declare function normalizeModelCredentialPayload(input: {
    providerId: string;
    authMode?: string;
    payload: unknown;
}): ModelCredentialPayload;
export declare function normalizePartialModelCredentialPayload(input: {
    providerId: string;
    authMode: string;
    payload: unknown;
}): ModelCredentialPayload;
export declare function resolveModelCredentialMode(provider: ModelProviderDefinition, authMode?: string): ModelCredentialModeDefinition;
