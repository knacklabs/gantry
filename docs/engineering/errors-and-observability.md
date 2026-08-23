# Errors and observability

Expected domain failures use typed errors that preserve stable meaning across
delivery adapters. Boundaries translate them into safe API, CLI, channel, or job
outcomes. Unexpected failures retain causes and stack context and are handled by
the owning process boundary; do not catch and silently continue.

Logs are structured events with stable names and relevant app, agent,
conversation, run, job, provider-account, or worker identifiers. Never log raw
credentials, authorization headers, secret references, message bodies by
default, or unbounded provider payloads. Metrics describe rates, latency,
capacity, saturation, and outcomes; traces connect work across owned boundaries.
Audit records capture security/authority decisions separately from diagnostic
logs.

Retries require a classified transient error, bounded backoff, idempotency, and
an observable terminal outcome. User-facing errors state what failed and the
safe next action without exposing internals.

**Mechanical:** ESLint rejects configured catch-all patterns; typecheck/tests and
existing telemetry schemas cover structured paths.

**Review:** Reviewers verify error ownership, redaction, correlation, cardinality,
retry safety, and that failures cannot become false success.

**Recommendation:** Emit one event at the boundary that can act, enriched with
context from lower layers, instead of duplicating the same exception at every
call frame.
