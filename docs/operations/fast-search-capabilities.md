# Fast Search via Host CLI

## Recommended Path

For short, current-info questions, MyClaw should start with the built-in fast lookup helper and use generic web lookup only when it needs deeper follow-up detail.

Use this shape:

```text
agent -> WebSearch/WebFetch -> mcp__myclaw__fast_lookup (fallback) -> public lookup endpoint
```

The current helper supports:

- `lookup "<query>"` for quick factual lookups
- `search "<query>"` for general fast search results
- `weather "<location>"` for weather-only questions

## Why This Path

This is a small host-first fallback capability:

- no new search provider account is required
- responses are fast and structured
- the agent can summarize JSON directly when primary web lookup is unavailable

## Agent Usage

Agents should prefer the structured MyClaw tool:

```text
mcp__myclaw__fast_lookup
```

Use:

- `mode=lookup` for short current-info questions
- `mode=search` for general quick results
- `mode=weather` for weather-only questions

For manual host debugging, the bundled CLI is still useful:

```bash
node "$MYCLAW_FAST_LOOKUP_CLI" lookup "weather today in Hyderabad"
node "$MYCLAW_FAST_LOOKUP_CLI" search "latest OpenAI API pricing"
```

Guidelines:

1. Start with `mcp__myclaw__fast_lookup` for short up-to-date questions.
2. If a good result needs more detail, use `WebFetch` on the strongest source URL.
3. If fast lookup is insufficient, use `WebSearch` or `WebFetch` as a follow-up, not the default first step.
4. If fast lookup returns a useful answer, summarize it directly.
5. If both paths fail, mention the exact failed tool(s) briefly.

## Sources

The current helper uses public fast endpoints:

- DuckDuckGo Instant Answer
- Wikipedia search fallback
- `wttr.in` for weather

These are convenience sources, not guaranteed enterprise-grade APIs. If you need stricter SLAs or richer results, replace the helper with a dedicated provider later.
