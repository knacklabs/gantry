const BROWSER_WRONG_LANE_GUIDANCE = [
    'Browser control is a built-in Gantry tool capability, not a skill install or third-party MCP server request.',
    'Do not request browser automation through request_skill_install or request_mcp_server.',
    'Ask a configured conversation approver to approve Browser access, then use the browser tools.',
].join(' ');
export function browserWrongLaneRequestGuidance(_toolName, payload) {
    if (!isBrowserWrongLanePayload(payload))
        return null;
    return {
        content: [
            {
                type: 'text',
                text: `${BROWSER_WRONG_LANE_GUIDANCE} No install request was recorded.`,
            },
        ],
        isError: true,
    };
}
function isBrowserWrongLanePayload(payload) {
    return [
        payload.name,
        payload.slug,
        payload.spec,
        payload.origin,
        payload.docsUrl,
        payload.package,
        payload.expectedFiles,
        payload.dependencies,
        payload.installCommandArgv,
        payload.requestedToolPatterns,
    ]
        .flatMap(explicitWrongLaneText)
        .some(isBrowserWrongLaneText);
}
function explicitWrongLaneText(value) {
    if (typeof value === 'string')
        return [value];
    if (Array.isArray(value))
        return value.flatMap(explicitWrongLaneText);
    return [];
}
function isBrowserWrongLaneText(value) {
    const normalized = value.toLowerCase();
    const compact = normalized.replace(/[^a-z0-9]+/g, '');
    return (normalized === 'browser' ||
        normalized === 'browser-control' ||
        compact === 'browserbackend' ||
        compact === 'browsercontrol');
}
