const CLAUDE_RUNTIME_ALLOWED_MODELS = ['sonnet', 'opus', 'haiku'];
const DEFAULT_CLAUDE_RUNTIME_MODEL = 'opus';
function assertNoRawSecrets(value, pathParts = []) {
    if (value === null || value === undefined)
        return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertNoRawSecrets(item, [...pathParts, String(index)]));
        return;
    }
    if (typeof value !== 'object')
        return;
    for (const [key, nested] of Object.entries(value)) {
        if (/api[_-]?key|oauth|token|secret|password/i.test(key)) {
            throw new Error(`Claude settings cannot include raw secret field ${[
                ...pathParts,
                key,
            ].join('.')}`);
        }
        assertNoRawSecrets(nested, [...pathParts, key]);
    }
}
export function renderClaudeSettings(input) {
    assertNoRawSecrets(input.providerOptions);
    const model = input.model || input.llmProfile?.modelAlias || DEFAULT_CLAUDE_RUNTIME_MODEL;
    return {
        env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
        },
        availableModels: CLAUDE_RUNTIME_ALLOWED_MODELS,
        model: String(model),
        autoMemoryEnabled: false,
        hooks: {},
    };
}
export function stringifyClaudeSettings(settings) {
    assertNoRawSecrets(settings);
    return `${JSON.stringify(settings, null, 2)}\n`;
}
