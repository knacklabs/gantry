export const NEUTRAL_CA_TRUST_ENV_KEYS = [
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'PIP_CERT',
  'AWS_CA_BUNDLE',
  'CARGO_HTTP_CAINFO',
  'DENO_CERT',
] as const;

export function applyNeutralCaTrustAliases(
  target: Record<string, string | undefined>,
): void {
  const caPath = target.NODE_EXTRA_CA_CERTS?.trim();
  if (!caPath) return;
  for (const key of NEUTRAL_CA_TRUST_ENV_KEYS) {
    target[key] = caPath;
  }
}
