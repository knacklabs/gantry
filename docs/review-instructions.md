# Review Instructions

Use these checks before approving large architecture or runtime changes:

1. Run `npm run check:architecture` or `python3 scripts/check_architecture.py`.
2. Treat any new unexcepted architecture violation as blocking unless the change is explicitly a cleanup that removes more debt than it adds.
3. Review `scripts/architecture-map.json` when a change introduces a new owned layer, adapter family, provider boundary, or package surface.
4. Keep `scripts/architecture-exceptions.json` empty unless a waiver is both deliberate and narrower than changing the map. File line-budget violations are never waived.
5. Provider-specific SDKs, channel SDKs, browser automation, Docker, and direct process execution must stay in approved adapter paths. Core domain and application files should not gain exceptions for these.
6. Old architecture terms such as `groupFolder`, `mainGroup`, `registeredGroup`, and Claude-only assumptions should trend down. New files should not introduce them.

When removing debt, delete the matching exception in the same change. If the checker reports that an exception is stale or over-capped, prefer fixing the exception rather than weakening the rule.
