# Configuration and secrets

Configuration expresses non-secret behavior and is validated at the boundary
before runtime use. Human-readable settings, durable desired-state revisions,
process environment, and runtime defaults have explicit precedence documented
in current architecture and accepted decisions.

Secrets and credentials never belong in source, examples, settings files,
plans, logs, or generated artifacts. Store references in configuration and
resolve values through Gantry's credential boundary. Project credentials only
into the model, tool network, provider, or child-process lane that owns them.
Raw provider tokens must not cross into general tool subprocess environments.

Environment variables use stable names, documented type/default/required
semantics, and startup validation. Adding or renaming one is a contract change.
Examples use obvious placeholders, not live-looking values.

**Mechanical:** settings schemas, startup validation, secret scanning, protected
file rules, and documentation checks detect known violations.

**Review:** Reviewers inspect precedence, least-privilege projection, redaction,
rotation impact, failure behavior, and deployment documentation.

**Recommendation:** Prefer one typed configuration owner over repeated
`process.env` reads distributed through application code.
