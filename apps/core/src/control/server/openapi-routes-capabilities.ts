import { doc, ids, type RouteDoc } from './openapi-route-helpers.js';

export const capabilityOpenApiRouteDocs: RouteDoc[] = [
  doc(
    'get',
    '/v1/inventory',
    'getInventory',
    'Capabilities',
    'List global inventory',
    'Returns read-only global onboarded tools, skills, and MCP servers.',
    ['agents:admin'],
  ),
  doc(
    'get',
    '/v1/capabilities',
    'listCapabilities',
    'Capabilities',
    'List approved capabilities',
    'Returns approved immutable capability manifests.',
    ['agents:admin'],
  ),
  doc(
    'get',
    '/v1/capabilities/{capabilityId}',
    'getCapability',
    'Capabilities',
    'Get one approved capability',
    'Returns the immutable capability manifest and projection metadata.',
    ['agents:admin'],
    { parameters: [ids.capability] },
  ),
  doc(
    'put',
    '/v1/capabilities/{capabilityId}',
    'putCapability',
    'Capabilities',
    'Register one reviewed MCP capability',
    'Idempotently registers an immutable app-scoped semantic capability with exact bindings to reviewed tools on active MCP sources.',
    ['agents:admin'],
    { body: 'json', parameters: [ids.capability] },
  ),
];
