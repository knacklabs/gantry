# Provider Session Ceiling Operations

The provider-session ceiling prevents an oversized provider context from being
resumed again. It does not migrate sessions created before the ceiling was
deployed, because those rows have no measured high-water mark.

## Pre-deploy reset

1. Drain inbound traffic and pause scheduled work.
2. Wait for running and queued agent runs to finish. Do not deploy while this
   query returns a non-zero count:

   ```sql
   SELECT count(*) AS unsettled_run_count
   FROM agent_runs
   WHERE status IN ('queued', 'running');
   ```

3. Send `/new` once in every installed conversation. One reset covers that
   conversation scope and its thread descendants. Use the normal command path;
   do not update session tables directly.
4. Confirm that no resumable provider session remains. Any returned row is a
   deployment stop condition: keep traffic drained, finish the missing reset,
   and repeat the query.

   ```sql
   SELECT ps.id, ps.agent_session_id, ps.provider, ps.status
   FROM provider_sessions AS ps
   WHERE ps.status IN ('active', 'ready', 'maintenance_compact')
   ORDER BY ps.agent_session_id, ps.provider, ps.id;
   ```

5. Deploy, resume scheduled work, and reopen inbound traffic only after both
   checks are clear.

## Orphan scan

Provider cleanup is best-effort. A `session.provider.cleanup_failed` event is a
reconciliation candidate: verify whether the provider artifact still exists
before releasing it. Group repeated failures by the hashed external session
reference; never copy a raw external session id into a ticket or log.

```sql
SELECT
  payload_json::jsonb->>'providerSessionHash' AS provider_session_hash,
  payload_json::jsonb->>'executionProviderId' AS execution_provider_id,
  max(created_at) AS last_failure_at,
  count(*)::integer AS failure_count
FROM runtime_events
WHERE event_type = 'session.provider.cleanup_failed'
GROUP BY
  payload_json::jsonb->>'providerSessionHash',
  payload_json::jsonb->>'executionProviderId'
ORDER BY last_failure_at DESC;
```

Verify every returned reference through the owning provider's cleanup
procedure and release any artifact that remains. Preserve the event as audit
history; rerunning this historical scan confirms the failure record remains,
not whether cleanup later succeeded.

## Observability recipe

Run this query for the deployment's observation window. It reports ceiling,
fingerprint, missing-session, and `/new` retirements separately, alongside
provider cleanup failures. Alert when cleanup failures are non-zero or ceiling
retirements rise unexpectedly after a cap change.

<!-- provider-session-ceiling-observability-sql:start -->

```sql
SELECT
  event_type,
  CASE
    WHEN event_type = 'session.provider.retired'
      THEN payload_json::jsonb->>'reason'
    ELSE NULL
  END AS reason,
  count(*)::integer AS event_count
FROM runtime_events
WHERE event_type IN (
  'session.provider.retired',
  'session.provider.cleanup_failed'
)
  AND created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
GROUP BY event_type, reason
ORDER BY event_type, reason NULLS LAST;
```

<!-- provider-session-ceiling-observability-sql:end -->

For a retirement, `providerSessionHash` and `executionProviderId` identify the
external artifact without exposing its raw id. Ceiling retirements also carry
`contextHighWaterMark` and `cap`. Cleanup failures carry `error`; they do not
carry a retirement reason.
