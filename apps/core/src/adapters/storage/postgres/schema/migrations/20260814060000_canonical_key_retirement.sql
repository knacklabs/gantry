-- S4 (decision 0122/0125): amendment identity becomes
-- (capability, canonical proposed templates) - the observed argv is one
-- redacted sample, no longer part of the dedup key. Old argv-bearing keys
-- can never match a new proposal, so surviving PENDING rows under the old
-- vocabulary are retired outright (keep-newest per capability; older and
-- unmatchable rows supersede via denied/system:superseded). Terminal rows
-- stay as history.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY app_id, capability_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM "capability_template_amendment_proposals"
  WHERE status = 'pending'
)
UPDATE "capability_template_amendment_proposals" AS proposals
SET status = 'denied',
    decided_by = 'system:superseded',
    decision_reason = 'Superseded by the argv-free canonical amendment identity.',
    decided_at = now(),
    updated_at = now()
FROM ranked
WHERE proposals.id = ranked.id
  AND ranked.rn > 1;
