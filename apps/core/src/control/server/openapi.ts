import {
  errors,
  type BodyKind,
  type JsonSchema,
  type RouteDoc,
} from './openapi-route-helpers.js';
import {
  openApiRequestSchemas,
  openApiResponseSchemas,
} from './openapi-operation-schemas.js';
import { coreOpenApiRouteDocs } from './openapi-routes-core.js';
import { extendedOpenApiRouteDocs } from './openapi-routes-extended.js';
import { adminOpenApiSchemas } from './openapi-schemas-admin.js';
import { automationOpenApiSchemas } from './openapi-schemas-automation.js';
import { extensionOpenApiSchemas } from './openapi-schemas-extensions.js';
import { llmOpenApiSchemas } from './openapi-schemas-llm.js';
import { controlOpenApiSchemas } from './openapi-schemas-control.js';
import { openApiSchemas } from './openapi-schemas.js';

const routeDocs: RouteDoc[] = [
  ...coreOpenApiRouteDocs,
  ...extendedOpenApiRouteDocs,
];

function response(description: string, schema: JsonSchema) {
  return { description, content: { 'application/json': { schema } } };
}

function requestBody(kind: BodyKind | undefined): JsonSchema | undefined {
  if (!kind || kind === 'none') return undefined;
  if (kind === 'zip') {
    return {
      required: true,
      description: 'Zip archive containing a skill package.',
      content: {
        'application/zip': { schema: { type: 'string', format: 'binary' } },
      },
    };
  }
  throw new Error('JSON request bodies require an operation schema');
}

function jsonRequestBody(schema: JsonSchema): JsonSchema {
  return {
    required: true,
    description: 'JSON request payload.',
    content: { 'application/json': { schema } },
  };
}

function statusDescription(status: '200' | '201' | '202' | '409'): string {
  if (status === '201') return 'Resource created.';
  if (status === '202') return 'Request accepted for asynchronous processing.';
  if (status === '409') return 'Request conflicts with current API policy.';
  return 'Request succeeded.';
}

function operationFromDoc(doc: RouteDoc) {
  const status = doc.status ?? '200';
  const responseSchema = openApiResponseSchemas[doc.operationId];
  if (!responseSchema) {
    throw new Error(`Missing OpenAPI response schema for ${doc.operationId}`);
  }
  const operation: Record<string, unknown> = {
    operationId: doc.operationId,
    tags: [doc.tag],
    summary: doc.summary,
    description: doc.description,
    parameters: doc.parameters,
    responses: {
      [status]: response(statusDescription(status), responseSchema),
      ...errors,
    },
  };
  const requestSchema = openApiRequestSchemas[doc.operationId];
  if (doc.body === 'json' && !requestSchema) {
    throw new Error(`Missing OpenAPI request schema for ${doc.operationId}`);
  }
  const body = requestSchema
    ? jsonRequestBody(requestSchema)
    : requestBody(doc.body);
  if (body) operation.requestBody = body;
  if (doc.scopes) {
    operation.security = [{ bearerAuth: doc.scopes }];
    operation['x-gantry-required-scopes'] = doc.scopes;
  }
  return operation;
}

function buildPaths(): Record<string, Record<string, Record<string, unknown>>> {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const route of routeDocs) {
    paths[route.path] ??= {};
    paths[route.path][route.method] = operationFromDoc(route);
  }
  return paths;
}

export const GANTRY_OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Gantry Control API',
    version: '1.0.0',
    description:
      'Provider-neutral runtime Control API for SDK sessions, jobs, providers, conversations, memory, capabilities, skills, MCP servers, webhooks, and signed external ingresses.',
    license: { name: 'MIT' },
  },
  servers: [
    {
      url: 'http://127.0.0.1:8787',
      description:
        'TCP control server when GANTRY_CONTROL_PORT is set. Defaults to loopback; set GANTRY_CONTROL_HOST=0.0.0.0 only behind an authenticated deployment boundary.',
    },
  ],
  tags: [
    { name: 'System', description: 'Runtime health and diagnostics.' },
    { name: 'Agents', description: 'Agent identity and administration.' },
    { name: 'Capabilities', description: 'Capability selection.' },
    { name: 'Sessions', description: 'Durable SDK chat sessions.' },
    { name: 'LLM', description: 'Direct model invocation passthrough.' },
    { name: 'Models', description: 'Provider-neutral model catalog.' },
    { name: 'Providers', description: 'Provider connections.' },
    { name: 'Conversations', description: 'Conversations and bindings.' },
    { name: 'Jobs', description: 'Scheduled and manual agent jobs.' },
    { name: 'Runs', description: 'Job run history and events.' },
    { name: 'Webhooks', description: 'Outbound callback delivery.' },
    { name: 'External Ingresses', description: 'Signed inbound entrypoints.' },
    { name: 'Memory', description: 'App-scoped durable memory.' },
    { name: 'Settings', description: 'Read-only settings projection.' },
    { name: 'Skills', description: 'Reviewed local skill packages.' },
    { name: 'MCP Servers', description: 'Reviewed third-party MCP servers.' },
  ],
  paths: buildPaths(),
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Gantry control API token',
        description:
          'Use a token from GANTRY_CONTROL_API_KEYS_JSON. Operation-specific scopes are listed in x-gantry-required-scopes.',
      },
    },
    schemas: {
      ...openApiSchemas,
      ...adminOpenApiSchemas,
      ...automationOpenApiSchemas,
      ...extensionOpenApiSchemas,
      ...llmOpenApiSchemas,
      ...controlOpenApiSchemas,
      ErrorEnvelope: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'details', 'retryable', 'requestId'],
            properties: {
              code: { type: 'string', example: 'INVALID_REQUEST' },
              message: { type: 'string' },
              details: { oneOf: [{ type: 'object' }, { type: 'null' }] },
              retryable: { type: 'boolean' },
              requestId: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
    },
    responses: {
      BadRequest: response('Invalid request.', {
        $ref: '#/components/schemas/ErrorEnvelope',
      }),
      Unauthorized: response('Missing or invalid API key.', {
        $ref: '#/components/schemas/ErrorEnvelope',
      }),
      Forbidden: response('API key lacks app access or required scopes.', {
        $ref: '#/components/schemas/ErrorEnvelope',
      }),
      NotFound: response('Requested resource was not found.', {
        $ref: '#/components/schemas/ErrorEnvelope',
      }),
      InternalError: response('Unexpected control server failure.', {
        $ref: '#/components/schemas/ErrorEnvelope',
      }),
    },
  },
} as const;

export function getGantryOpenApiDocument(): typeof GANTRY_OPENAPI_DOCUMENT {
  return GANTRY_OPENAPI_DOCUMENT;
}
