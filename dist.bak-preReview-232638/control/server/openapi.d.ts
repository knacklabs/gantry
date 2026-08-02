import { type JsonSchema } from './openapi-route-helpers.js';
export declare const GANTRY_OPENAPI_DOCUMENT: {
    readonly openapi: "3.1.0";
    readonly info: {
        readonly title: "Gantry Control API";
        readonly version: "1.0.0";
        readonly description: "Provider-neutral runtime Control API for SDK sessions, jobs, providers, conversations, memory, capabilities, skills, MCP servers, webhooks, and signed external ingresses.";
        readonly license: {
            readonly name: "MIT";
        };
    };
    readonly servers: readonly [{
        readonly url: "http://127.0.0.1:8787";
        readonly description: "TCP control server when GANTRY_CONTROL_PORT is set. Defaults to loopback; set GANTRY_CONTROL_HOST=0.0.0.0 only behind an authenticated deployment boundary.";
    }];
    readonly tags: readonly [{
        readonly name: "System";
        readonly description: "Runtime health and diagnostics.";
    }, {
        readonly name: "Agents";
        readonly description: "Agent identity and administration.";
    }, {
        readonly name: "Capabilities";
        readonly description: "Capability selection.";
    }, {
        readonly name: "Sessions";
        readonly description: "Durable SDK chat sessions.";
    }, {
        readonly name: "LLM";
        readonly description: "Direct model invocation passthrough.";
    }, {
        readonly name: "Models";
        readonly description: "Provider-neutral model catalog.";
    }, {
        readonly name: "Providers";
        readonly description: "Provider connections.";
    }, {
        readonly name: "Conversations";
        readonly description: "Conversations and bindings.";
    }, {
        readonly name: "Jobs";
        readonly description: "Scheduled and manual agent jobs.";
    }, {
        readonly name: "Runs";
        readonly description: "Job run history and events.";
    }, {
        readonly name: "Usage";
        readonly description: "App-scoped token usage aggregation.";
    }, {
        readonly name: "Webhooks";
        readonly description: "Outbound callback delivery.";
    }, {
        readonly name: "External Ingresses";
        readonly description: "Signed inbound entrypoints.";
    }, {
        readonly name: "Memory";
        readonly description: "App-scoped durable memory.";
    }, {
        readonly name: "Observer";
        readonly description: "App-scoped proactive insight status and history.";
    }, {
        readonly name: "Settings";
        readonly description: "Read-only settings projection.";
    }, {
        readonly name: "Skills";
        readonly description: "Reviewed local skill packages.";
    }, {
        readonly name: "MCP Servers";
        readonly description: "Reviewed third-party MCP servers.";
    }];
    readonly paths: Record<string, Record<string, Record<string, unknown>>>;
    readonly components: {
        readonly securitySchemes: {
            readonly bearerAuth: {
                readonly type: "http";
                readonly scheme: "bearer";
                readonly bearerFormat: "Gantry control API token";
                readonly description: "Use a token from GANTRY_CONTROL_API_KEYS_JSON. Operation-specific scopes are listed in x-gantry-required-scopes.";
            };
        };
        readonly schemas: {
            readonly ErrorEnvelope: {
                readonly type: "object";
                readonly required: readonly ["error"];
                readonly properties: {
                    readonly error: {
                        readonly type: "object";
                        readonly required: readonly ["code", "message", "details", "retryable", "requestId"];
                        readonly properties: {
                            readonly code: {
                                readonly type: "string";
                                readonly example: "INVALID_REQUEST";
                            };
                            readonly message: {
                                readonly type: "string";
                            };
                            readonly details: {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                }, {
                                    readonly type: "null";
                                }];
                            };
                            readonly retryable: {
                                readonly type: "boolean";
                            };
                            readonly requestId: {
                                readonly type: "string";
                                readonly format: "uuid";
                            };
                        };
                    };
                };
            };
        };
        readonly responses: {
            readonly BadRequest: {
                description: string;
                content: {
                    'application/json': {
                        schema: JsonSchema;
                    };
                };
            };
            readonly Unauthorized: {
                description: string;
                content: {
                    'application/json': {
                        schema: JsonSchema;
                    };
                };
            };
            readonly Forbidden: {
                description: string;
                content: {
                    'application/json': {
                        schema: JsonSchema;
                    };
                };
            };
            readonly NotFound: {
                description: string;
                content: {
                    'application/json': {
                        schema: JsonSchema;
                    };
                };
            };
            readonly Conflict: {
                description: string;
                content: {
                    'application/json': {
                        schema: JsonSchema;
                    };
                };
            };
            readonly InternalError: {
                description: string;
                content: {
                    'application/json': {
                        schema: JsonSchema;
                    };
                };
            };
        };
    };
};
export declare function getGantryOpenApiDocument(): typeof GANTRY_OPENAPI_DOCUMENT;
