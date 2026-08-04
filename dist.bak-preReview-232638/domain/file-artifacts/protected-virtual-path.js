import { normalizeFileArtifactPath } from './virtual-path.js';
// Virtual scope that holds each agent's durable prompt-profile artifacts
// (SOUL.md / AGENTS.md). The profile reader only ever reads from this scope, so
// profile protection is anchored here rather than matching the filename in any
// scope — an ordinary user artifact named AGENTS.md elsewhere is not a profile.
export const PROMPT_PROFILE_VIRTUAL_SCOPE = 'prompt-profile';
// Per-agent profile prose files. These are advisory profile content but are
// edited only through the reviewed request_agent_profile_update flow, never via
// the generic file tool.
const PROTECTED_PROFILE_FILE_SEGMENTS = new Set(['SOUL.md', 'AGENTS.md']);
const PROTECTED_FILE_ARTIFACT_SEGMENTS = new Set([
    'SOUL.md',
    'settings.yaml',
    '.mcp.json',
    'SKILL.md',
]);
const PROTECTED_FILE_ARTIFACT_PREFIXES = ['.codex/skills/'];
export function isProtectedFileArtifactVirtualPath(value) {
    const virtualPath = normalizeFileArtifactPath(value);
    if (PROTECTED_FILE_ARTIFACT_PREFIXES.some((prefix) => virtualPath.startsWith(prefix))) {
        return true;
    }
    return virtualPath
        .split('/')
        .some((part) => PROTECTED_FILE_ARTIFACT_SEGMENTS.has(part));
}
export function isProtectedProfileFileArtifactVirtualPath(value) {
    return normalizeFileArtifactPath(value)
        .split('/')
        .some((part) => PROTECTED_PROFILE_FILE_SEGMENTS.has(part));
}
// A write targets an agent's durable profile artifact only when it lands in the
// prompt-profile scope with a profile filename. This is the sole path the
// profile reader consumes, so it is exactly what must be routed through
// request_agent_profile_update — without blocking unrelated artifacts that
// merely share the SOUL.md / AGENTS.md filename in another scope.
export function isAgentProfileArtifactWrite(virtualScope, virtualPath) {
    return (virtualScope === PROMPT_PROFILE_VIRTUAL_SCOPE &&
        isProtectedProfileFileArtifactVirtualPath(virtualPath));
}
