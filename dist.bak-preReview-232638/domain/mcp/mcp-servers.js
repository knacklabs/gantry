const MCP_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const RESERVED_MCP_NAMES = new Set(['gantry']);
const SECRET_KEY_PATTERN = /(token|secret|password|credential|api[_-]?key|authorization|auth|bearer|cookie)/i;
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{16,}|[a-z0-9]+_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._\-~+/]+=*)/i;
export function assertValidMcpServerName(name) {
    if (!MCP_NAME_PATTERN.test(name)) {
        throw new Error('MCP server name must start with a lowercase letter and use only lowercase letters, numbers, underscore, or dash.');
    }
    if (RESERVED_MCP_NAMES.has(name)) {
        throw new Error(`MCP server name is reserved: ${name}`);
    }
}
export function normalizeMcpServerName(name) {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}
export function assertNoRawSecretsInMcpConfig(value, path = 'config') {
    if (value == null)
        return;
    if (typeof value === 'string') {
        if (SECRET_VALUE_PATTERN.test(value)) {
            throw new Error(`${path} contains a raw secret value. Use credentialRefs instead.`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertNoRawSecretsInMcpConfig(entry, `${path}[${index}]`));
        return;
    }
    if (typeof value !== 'object')
        return;
    for (const [key, entry] of Object.entries(value)) {
        if (SECRET_KEY_PATTERN.test(key) &&
            typeof entry === 'string' &&
            entry.trim()) {
            throw new Error(`${path}.${key} looks like a raw secret. Use credentialRefs instead.`);
        }
        assertNoRawSecretsInMcpConfig(entry, `${path}.${key}`);
    }
}
export function isMcpServerActive(definition) {
    return definition.status === 'active';
}
