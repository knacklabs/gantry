# Provider Model Discovery

Gantry can list models from configured Anthropic, OpenAI, OpenRouter, and
OpenAI-compatible accounts without making raw provider model IDs selectable.
Discovery is informational until an administrator explicitly registers an
alias in the settings-owned `model_aliases` catalog.

## Ownership and safety

- Provider adapters own discovery URLs, authentication headers, pagination,
  response parsing, and redirect policy. Credentials are read through the
  model credential repository and are never returned by the API.
- Each request has a five-second deadline, a 4 MiB response limit, a ten-page
  limit, and a 5,000-model limit. Successful results are cached for 15 minutes
  by app, provider, and credential fingerprint; concurrent refreshes share one
  outbound request sequence.
- Listings always merge live results with every registered alias. Provider
  failure returns saved aliases as `availability_unknown`, using the last
  successful cached discovery when available. Omitted saved models are marked
  `configured_not_advertised`; neither condition edits settings or history.
- The merge loads aliases from the requested app's desired-state revision.
  Provider adapters exclude entries that are explicitly non-generative or do
  not support text output; registration persists only the workloads validated
  for that discovered model.
- Registration requires the current desired-state revision. A concurrent
  settings edit returns `REVISION_CONFLICT`, and the caller must rediscover or
  retry against the new revision.

## Operator paths

```bash
gantry model discover anthropic
gantry model discover anthropic --refresh
gantry model discover openrouter
gantry model register openrouter vendor/model-id --alias my-model
gantry model set chat my-model
```

The control API exposes the same flow through
`GET /v1/model-providers/{providerId}/models` and
`POST /v1/model-registrations`. The SDK provides
`client.models.discover(providerId)` and `client.models.register(input)`.

Runtime selection continues to resolve aliases through the single model
catalog. Raw provider IDs are invalid selectors. New agent runs persist the
resolved alias, provider, provider model ID, and display name as nullable,
write-once snapshots so old rows remain valid and later catalog edits cannot
rewrite run identity. A provider invalid-model response becomes the terminal
`MODEL_NOT_AVAILABLE` error and is not eligible for model-family failover.
