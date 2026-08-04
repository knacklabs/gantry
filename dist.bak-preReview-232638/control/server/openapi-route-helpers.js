export const errors = {
    '400': { $ref: '#/components/responses/BadRequest' },
    '401': { $ref: '#/components/responses/Unauthorized' },
    '403': { $ref: '#/components/responses/Forbidden' },
    '404': { $ref: '#/components/responses/NotFound' },
    '500': { $ref: '#/components/responses/InternalError' },
};
const id = (name, description) => ({
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string' },
});
export const query = (name, description, schema = { type: 'string' }) => ({
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
    interaction: id('interactionId', 'Pending interaction id (the permission request id from the interactions list).'),
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
};
export function doc(method, path, operationId, tag, summary, description, scopes, options = {}) {
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
