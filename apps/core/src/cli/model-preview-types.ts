export interface ModelPreviewResponse {
  target?: string;
  jobId?: string;
  agentId?: string;
  scope?: string;
  // Resolved-route diagnostics for `why <alias> --agent <id>`. `agentEngine` is
  // the agent's effective engine; `executionProviderId` is the internal
  // diagnostic adapter the engine+route pair runs on; `credentialProfile` is the
  // bound credential profile ref. `incompatible` carries the locked pair copy.
  agentEngine?: string;
  agentEngineLabel?: string;
  executionProviderId?: string;
  credentialProfile?: string;
  incompatible?: string;
  selection?: {
    effectiveAlias?: string | null;
    source?: string;
    inherited?: boolean;
    model?: {
      displayName?: string;
      responseFamily?: string;
      modelRoute?: { label?: string; metadata?: { providerModelId?: string } };
      cacheSupport?: { statusLabel?: string };
    } | null;
  };
  why?: string[];
}
