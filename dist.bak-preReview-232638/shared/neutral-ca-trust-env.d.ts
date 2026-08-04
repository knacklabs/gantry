export declare const NEUTRAL_CA_TRUST_ENV_KEYS: readonly ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "PIP_CERT", "AWS_CA_BUNDLE", "CARGO_HTTP_CAINFO", "DENO_CERT"];
export declare function applyNeutralCaTrustAliases(target: Record<string, string | undefined>): void;
