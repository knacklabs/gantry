export interface RuntimeSecretRef {
  env: string;
}

export interface RuntimeSecretProvider {
  getSecret(ref: RuntimeSecretRef): string;
  getOptionalSecret(ref: RuntimeSecretRef): string | undefined;
}

/**
 * Minimal process.env-backed secret provider for the shared crypto package.
 * Unlike core's EnvRuntimeSecretProvider it does NOT read <GANTRY_HOME>/.env —
 * callers that need that (core, the connector) inject their own provider or set
 * the values on process.env before calling. Kept dependency-free so the crypto
 * package stays a leaf with no core imports.
 */
export class EnvRuntimeSecretProvider implements RuntimeSecretProvider {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  getSecret(ref: RuntimeSecretRef): string {
    const value = this.getOptionalSecret(ref);
    if (!value) {
      throw new Error(`${ref.env} is required.`);
    }
    return value;
  }

  getOptionalSecret(ref: RuntimeSecretRef): string | undefined {
    return this.source[ref.env]?.trim() || undefined;
  }
}
