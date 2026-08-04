const KNOWN_SECRET_PATTERNS = [
    [
        'provider_token',
        /\b(sk-[a-z0-9]{20,}|sk-ant-[a-z0-9_-]{20,}|gh[opusr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{20,}|xoxx-[a-z0-9-]{20,})\b/i,
    ],
    ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    [
        'jwt_token',
        /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._-]{10,}\.[a-zA-Z0-9._-]{10,}\b/,
    ],
    [
        'pem_private_key',
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
    ],
    [
        'secret_assignment',
        /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|private[_-]?key|session[_-]?id)\b\s*(?:=|:|is)\s*['"]?[a-z0-9._~+/-]{8,}['"]?/i,
    ],
    ['bearer_token', /\bbearer\s+[a-z0-9._~+/-]{16,}\b/i],
];
const REDACTION_RULES = [
    [
        /\b(sk-[a-z0-9]{20,}|sk-ant-[a-z0-9_-]{20,}|gh[opusr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{20,}|xoxx-[a-z0-9-]{20,})\b/gi,
        '[REDACTED_SECRET]',
    ],
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]'],
    [
        /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._-]{10,}\.[a-zA-Z0-9._-]{10,}\b/g,
        '[REDACTED_SECRET]',
    ],
    [
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi,
        '[REDACTED_SECRET]',
    ],
    [/\bbearer\s+[a-z0-9._~+/-]{16,}\b/gi, 'bearer [REDACTED_SECRET]'],
    [
        /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|private[_-]?key|session[_-]?id)\b\s*(?:=|:|is)\s*['"]?[a-z0-9._~+/-]{8,}['"]?/gi,
        '$1=[REDACTED_SECRET]',
    ],
];
const HIGH_RISK_CONTEXT_PATTERN = /\b(token|secret|password|passphrase|credential|auth|authorization|api[_-]?key|session|cookie|bearer)\b/i;
const CANDIDATE_TOKEN_PATTERN = /[A-Za-z0-9._~+/\-=]{24,}/g;
const REDACTION_MARKER_PATTERN = /\[REDACTED_(?:SECRET|POTENTIALLY_SENSITIVE)\]/g;
const PROMPT_INJECTION_PATTERNS = [
    [
        'ignore_previous_instructions',
        /\bignore\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|rules?)\b/i,
    ],
    [
        'override_system_instructions',
        /\b(?:override|bypass)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|instructions?)\b/i,
    ],
    [
        'exfiltrate_hidden_instructions',
        /\b(?:reveal|expose|leak|dump|print)\s+(?:the\s+)?(?:system|developer|hidden)\s+(?:prompt|instructions?)\b/i,
    ],
    ['prompt_injection_marker', /\b(?:jailbreak|prompt\s+injection)\b/i],
    [
        'instruction_override',
        /\bdo\s+not\s+follow\s+(?:the\s+)?(?:rules?|instructions?)\b/i,
    ],
    [
        'role_instruction',
        /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
    ],
];
function shannonEntropy(value) {
    if (!value)
        return 0;
    const counts = new Map();
    for (const ch of value) {
        counts.set(ch, (counts.get(ch) || 0) + 1);
    }
    let entropy = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
function looksLikeOpaqueSecretToken(raw) {
    const token = raw.replace(/^['"`]+|['"`]+$/g, '');
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(token)).length;
    return (token.length >= 24 &&
        token.length <= 1024 &&
        !token.includes('://') &&
        /[0-9]/.test(token) &&
        classes >= 3 &&
        shannonEntropy(token) >= 3.5);
}
export function classifySensitiveMemoryMaterial(text) {
    return firstPatternReason(text, KNOWN_SECRET_PATTERNS);
}
export function classifyPromptInjectionMemoryMaterial(text) {
    return firstPatternReason(text, PROMPT_INJECTION_PATTERNS);
}
export function classifyUnsafeMemoryMaterial(text) {
    return (classifySensitiveMemoryMaterial(text) ||
        classifyPromptInjectionMemoryMaterial(text));
}
export function detectPotentialUnredactedSecret(text) {
    const scanText = text.replace(REDACTION_MARKER_PATTERN, ' ');
    const trimmed = scanText.trim();
    if (!trimmed)
        return null;
    const candidates = trimmed.match(CANDIDATE_TOKEN_PATTERN) || [];
    for (const token of candidates) {
        if (!looksLikeOpaqueSecretToken(token))
            continue;
        if (token.length >= 40 || HIGH_RISK_CONTEXT_PATTERN.test(trimmed)) {
            return 'high_entropy_credential_like_token';
        }
    }
    return null;
}
export function redactSensitiveText(raw) {
    let redacted = raw;
    for (const [pattern, replacement] of REDACTION_RULES)
        redacted = redacted.replace(pattern, replacement);
    return redacted;
}
export function sanitizeOutboundLlmText(raw) {
    const redactedText = redactSensitiveText(raw);
    const blockedReason = detectPotentialUnredactedSecret(redactedText);
    return {
        text: blockedReason ? '[REDACTED_POTENTIALLY_SENSITIVE]' : redactedText,
        redacted: redactedText !== raw,
        blocked: Boolean(blockedReason),
        ...(blockedReason ? { reason: blockedReason } : {}),
    };
}
function firstPatternReason(text, checks) {
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    return checks.find(([, pattern]) => pattern.test(trimmed))?.[0] ?? null;
}
