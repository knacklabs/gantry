export type JsonSchema = Record<string, unknown>;
export type Method = 'delete' | 'get' | 'patch' | 'post' | 'put';
export type BodyKind = 'json' | 'none' | 'zip';

export type RouteDoc = {
  method: Method;
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description: string;
  scopes?: string[];
  status?: '200' | '201' | '202' | '409';
  body?: BodyKind;
  conflict?: boolean;
  parameters?: JsonSchema[];
};

export const errors: Record<string, JsonSchema> = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { $ref: '#/components/responses/Forbidden' },
  '404': { $ref: '#/components/responses/NotFound' },
  '500': { $ref: '#/components/responses/InternalError' },
};

const id = (name: string, description: string): JsonSchema => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});
export const query = (
  name: string,
  description: string,
  schema: JsonSchema = { type: 'string' },
): JsonSchema => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
});

export const ids = {
  agent: id('agentId', 'Agent id.'),
  capability: id('capabilityId', 'Capability id.'),
  conversation: id('conversationId', 'Conversation id.'),
  file: id('filePath', 'Skill-relative file path.'),
  ingress: id('ingressId', 'Ingress id.'),
  job: id('jobId', 'Job id.'),
  memory: id('memoryId', 'Memory item id.'),
  modelCredentialProvider: id('providerId', 'Model credential provider id.'),
  profileFileKind: id('kind', 'Profile file kind (soul | agents).'),
  providerAccount: id('providerAccountId', 'Provider account id.'),
  run: id('runId', 'Run id.'),
  server: id('serverId', 'MCP server id.'),
  session: id('sessionId', 'Session id.'),
  skill: id('skillId', 'Skill id.'),
  trigger: id('triggerId', 'Trigger id.'),
  webhook: id('webhookId', 'Webhook id.'),
} as const;

export function doc(
  method: Method,
  path: string,
  operationId: string,
  tag: string,
  summary: string,
  description: string,
  scopes?: string[],
  options: Pick<RouteDoc, 'body' | 'conflict' | 'parameters' | 'status'> = {},
): RouteDoc {
  return {
    method,
    path,
    operationId,
    tag,
    summary,
    description,
    scopes,
    ...options,
  };
}
