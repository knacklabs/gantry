const LOOPBACK_NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

function splitNoProxy(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function mergeLoopbackNoProxy(value: string | undefined): string {
  const merged = new Set(splitNoProxy(value));
  for (const host of LOOPBACK_NO_PROXY_HOSTS) {
    merged.add(host);
  }
  return [...merged].join(',');
}

export function applyLoopbackNoProxyEnv(
  env: Record<string, string | undefined>,
): void {
  const existing = env.NO_PROXY || env.no_proxy;
  const merged = mergeLoopbackNoProxy(existing);
  env.NO_PROXY = merged;
  env.no_proxy = merged;
}
