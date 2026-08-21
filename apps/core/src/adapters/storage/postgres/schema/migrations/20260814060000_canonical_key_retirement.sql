-- S4 (decision 0122/0125): amendment identity becomes
-- (capability, canonical proposed templates) - the observed argv is one
-- redacted sample, no longer part of the dedup key. Recompute every
-- PENDING row's canonical key under the new identity (compact sorted-key
-- JSON, matching shared/stable-hash.ts), supersede older duplicates
-- keep-newest via denied/system:superseded, and re-key the survivors so
-- new proposals deduplicate against them. Terminal rows stay as history.
WITH keyed AS (
  SELECT p.id,
         p.app_id,
         p.created_at,
         encode(sha256(convert_to(
           '{"capabilityId":' || to_json(trim(p.capability_id))::text ||
           ',"proposedTemplates":[' ||
           COALESCE((
             SELECT string_agg(to_json(elem.value)::text, ',' ORDER BY elem.ordinality)
             FROM jsonb_array_elements_text(p.proposed_templates) WITH ORDINALITY AS elem(value, ordinality)
           ), '') || ']}',
           'UTF8')), 'hex') AS new_key
  FROM "capability_template_amendment_proposals" p
  WHERE p.status = 'pending'
), ranked AS (
  SELECT keyed.id,
         keyed.new_key,
         row_number() OVER (
           PARTITION BY keyed.app_id, keyed.new_key
           ORDER BY keyed.created_at DESC, keyed.id DESC
         ) AS rn
  FROM keyed
)
UPDATE "capability_template_amendment_proposals" AS proposals
SET status = 'denied',
    decided_by = 'system:superseded',
    decision_reason = 'Superseded by a newer proposal under the argv-free canonical amendment identity.',
    decided_at = now(),
    updated_at = now()
FROM ranked
WHERE proposals.id = ranked.id
  AND ranked.rn > 1;
--> statement-breakpoint
WITH keyed AS (
  SELECT p.id,
         encode(sha256(convert_to(
           '{"capabilityId":' || to_json(trim(p.capability_id))::text ||
           ',"proposedTemplates":[' ||
           COALESCE((
             SELECT string_agg(to_json(elem.value)::text, ',' ORDER BY elem.ordinality)
             FROM jsonb_array_elements_text(p.proposed_templates) WITH ORDINALITY AS elem(value, ordinality)
           ), '') || ']}',
           'UTF8')), 'hex') AS new_key
  FROM "capability_template_amendment_proposals" p
  WHERE p.status = 'pending'
)
UPDATE "capability_template_amendment_proposals" AS proposals
SET canonical_key = keyed.new_key,
    updated_at = now()
FROM keyed
WHERE proposals.id = keyed.id;
