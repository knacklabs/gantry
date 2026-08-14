-- S4 (decision 0122/0125): amendment identity becomes
-- (capability, canonical proposed templates) - the observed argv is one
-- redacted sample, no longer part of the dedup key. Old argv-bearing keys
-- cannot be recomputed in SQL and can never match a new proposal, so ALL
-- surviving PENDING rows under the old vocabulary are retired outright via
-- denied/system:superseded (the host path is dormant; a genuine mismatch
-- recompiles a fresh proposal under the new identity). Terminal rows stay
-- as history.
UPDATE "capability_template_amendment_proposals"
SET status = 'denied',
    decided_by = 'system:superseded',
    decision_reason = 'Superseded by the argv-free canonical amendment identity.',
    decided_at = now(),
    updated_at = now()
WHERE status = 'pending';
