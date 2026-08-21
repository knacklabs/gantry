UPDATE "memory_review_requests"
SET "review_snapshot_json" = json_build_object(
	'schemaVersion', 1,
	'subject', json_build_object(
		'appId', "app_id",
		'agentId', "agent_id",
		'subjectType', "subject_type",
		'subjectId', "subject_id"
	),
	'evidence', json_build_array()
)::text
WHERE "review_snapshot_json" IS NULL;--> statement-breakpoint
ALTER TABLE "memory_review_requests" ALTER COLUMN "review_snapshot_json" SET NOT NULL;
