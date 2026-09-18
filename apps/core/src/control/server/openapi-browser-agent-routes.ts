import { ids, type RouteDoc } from './openapi-route-helpers.js';

export const browserAgentOpenApiRouteDocs: RouteDoc[] = [
  {
    method: 'get',
    path: '/ui/api/agents/{agentId}/workflow-map',
    operationId: 'getBrowserAgentWorkflowMap',
    tag: 'Agents',
    summary: 'Read an employee workflow map',
    description:
      'Returns configured conversations, jobs, model, sources, and approvers for one app-scoped AI employee.',
    parameters: [ids.agent],
  },
];
