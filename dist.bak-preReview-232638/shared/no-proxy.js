const AGENT_EGRESS_NO_PROXY_HOSTS = [
    '127.0.0.1',
    'localhost',
    '::1',
    'github.com',
    '.github.com',
    'api.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'codeload.github.com',
];
const AGENT_EGRESS_LOOPBACK_NO_PROXY_HOSTS = [
    '127.0.0.1',
    'localhost',
    '::1',
];
function splitNoProxy(value) {
    if (!value)
        return [];
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}
function mergeNoProxyHosts(values, defaults) {
    const out = [];
    const seen = new Set();
    const userHosts = values.flatMap((value) => splitNoProxy(value));
    for (const host of [...userHosts, ...defaults]) {
        const key = host.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(host);
    }
    return out.join(',');
}
export function mergeAgentEgressNoProxy(...values) {
    return mergeNoProxyHosts(values, AGENT_EGRESS_NO_PROXY_HOSTS);
}
export function applyAgentEgressNoProxyEnv(env, options = {}) {
    const values = [env.NO_PROXY, env.no_proxy];
    const merged = options.externalBypass === false
        ? mergeNoProxyHosts(values.map((value) => splitNoProxy(value).filter(isLoopbackNoProxy).join(',')), AGENT_EGRESS_LOOPBACK_NO_PROXY_HOSTS)
        : mergeAgentEgressNoProxy(...values);
    env.NO_PROXY = merged;
    env.no_proxy = merged;
}
function isLoopbackNoProxy(host) {
    const value = host.toLowerCase();
    return (value === '127.0.0.1' ||
        value === 'localhost' ||
        value === '::1' ||
        value === '[::1]');
}
