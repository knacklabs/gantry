# Architecture Docs Guidance

- When documenting Boondi warm-pool cache prewarm, distinguish SDK `startup()`
  from provider prompt-cache writes. Provider-cache prewarm means a throwaway
  synthetic Anthropic Agent SDK query for a `cacheShapeKey`, verified by cache
  read/write usage evidence, then destroyed before customer traffic.
