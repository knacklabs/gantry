# Performance

Performance work starts from an observable user or operator outcome and a
repeatable baseline. Preserve correctness, authority, cancellation, and
durability while reducing work; do not trade hidden data loss for lower latency.

Bound concurrency at the owner that can enforce capacity. Avoid unbounded
collections, payloads, retries, logs, fan-out, database queries, and background
tasks. Batch or stream only when ordering, partial failure, memory, and
cancellation semantics are explicit. Database changes consider query plans,
indexes, round trips, lock contention, and pool capacity. Hot paths avoid
duplicate parsing, serialization, hydration, and network hops.

**Mechanical:** file/architecture budgets, focused benchmarks where committed,
load/concurrency tests, and regression suites detect known ceilings.

**Review:** Performance-sensitive PRs provide before/after method, workload,
environment, variance, and correctness checks. Reviewers inspect N+1 queries,
resource cleanup, queue saturation, and cardinality.

**Recommendation:** Optimize the measured bottleneck at its ownership boundary;
do not add caches, queues, or parallelism without invalidation, backpressure, and
failure contracts.
