CREATE TABLE "embedding_cache" (
	"text_hash" text NOT NULL,
	"model" text NOT NULL,
	"embedding_json" text NOT NULL,
	"embedding" vector(1536),
	"dimensions" integer DEFAULT 1536 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "embedding_cache_pk" PRIMARY KEY("text_hash","model")
);
--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"thread_id" text,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"reason" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"evidence_ids_json" text DEFAULT '[]' NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_dream_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text,
	"item_id" text,
	"candidate_id" text,
	"action" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence_ids_json" text DEFAULT '[]' NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_dream_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"thread_id" text,
	"phase" text NOT NULL,
	"status" text NOT NULL,
	"summary_json" text DEFAULT '{}' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_embedding_backfill_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"trigger" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"total_candidates" integer DEFAULT 0 NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"ready_count" integer DEFAULT 0 NOT NULL,
	"skipped_ready_count" integer DEFAULT 0 NOT NULL,
	"retryable_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"pause_reason" text,
	"last_error_code" text,
	"last_error_message" text,
	"resume_after" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"user_id" text,
	"group_id" text,
	"channel_id" text,
	"thread_id" text,
	"source_type" text NOT NULL,
	"source_id" text,
	"actor_id" text,
	"text" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_item_embeddings" (
	"item_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_json" text,
	"embedding" vector(1536),
	"dimensions" integer DEFAULT 1536 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"resume_after" timestamp with time zone,
	"run_id" uuid,
	"provider_batch_id" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_item_embeddings_pk" PRIMARY KEY("item_id","provider","model","content_hash")
);
--> statement-breakpoint
CREATE TABLE "memory_recall_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memory_recall_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"item_id" text NOT NULL,
	"query_hash" text NOT NULL,
	"score" double precision NOT NULL,
	"subject_json" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_review_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"thread_id" text,
	"phase" text NOT NULL,
	"proposal_json" text NOT NULL,
	"item_versions_json" text DEFAULT '{}' NOT NULL,
	"candidate_versions_json" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"validation_summary" text NOT NULL,
	"flagged_content_hash" text,
	"reviewer_id" text,
	"decision" text,
	"edited_value" text,
	"edited_reason" text,
	"apply_outcome" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "permission_promotion_counters" (
	"app_id" text NOT NULL,
	"agent_folder" text NOT NULL,
	"suggestion_key" text NOT NULL,
	"allow_count" integer DEFAULT 0 NOT NULL,
	"last_offered_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "permission_promotion_counters_pk" PRIMARY KEY("app_id","agent_folder","suggestion_key")
);
--> statement-breakpoint
CREATE TABLE "router_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text,
	"external_user_id" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"kind" text DEFAULT 'human' NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_config_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"prompt_profile_ref" text NOT NULL,
	"llm_profile_id" text NOT NULL,
	"capability_refs_json" text DEFAULT '[]' NOT NULL,
	"source_refs_json" text DEFAULT '[]' NOT NULL,
	"permission_policy_ids_json" text DEFAULT '[]' NOT NULL,
	"sandbox_profile_id" text,
	"workspace_snapshot_id" text,
	"runtime_limits_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_config_versions_agent_id_version_unique" UNIQUE("agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_config_version_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"purpose" text NOT NULL,
	"response_family" text DEFAULT 'anthropic' NOT NULL,
	"model_alias" text NOT NULL,
	"thinking_json" text DEFAULT '{}' NOT NULL,
	"budget_json" text DEFAULT '{}' NOT NULL,
	"credential_profile_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_async_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text,
	"thread_id" text,
	"parent_run_id" text,
	"parent_job_id" text,
	"parent_job_run_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"admission_class" text NOT NULL,
	"authority_snapshot_json" jsonb NOT NULL,
	"private_correlation_json" jsonb NOT NULL,
	"lease_token" text NOT NULL,
	"fencing_version" integer DEFAULT 1 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"summary" text,
	"output_summary" text,
	"error_summary" text,
	"receipt_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "brain_dream_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"run_id" text NOT NULL,
	"page_id" text,
	"op_json" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_dream_state" (
	"app_id" text PRIMARY KEY NOT NULL,
	"cursor_updated_at" timestamp with time zone,
	"cursor_page_id" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"type" text NOT NULL,
	"from_entity_id" text NOT NULL,
	"to_entity_id" text NOT NULL,
	"evidence_page_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_page_embeddings" (
	"page_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_json" text,
	"embedding" vector(1536),
	"dimensions" integer DEFAULT 1536 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brain_page_embeddings_pk" PRIMARY KEY("page_id","provider","model","content_hash")
);
--> statement-breakpoint
CREATE TABLE "brain_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"markdown" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text,
	"author_id" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_profiles" (
	"profile_name" text PRIMARY KEY NOT NULL,
	"app_id" text,
	"content_hash" text NOT NULL,
	"storage_ref" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"auth_markers_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot_worker_instance_id" text,
	"snapshot_run_id" text,
	"snapshot_fencing_version" integer DEFAULT 0 NOT NULL,
	"snapshotted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"allowed_capability_ids_json" text DEFAULT '[]' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"thread_id" text,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"memory_scope" text DEFAULT 'conversation' NOT NULL,
	"memory_subject_json" text NOT NULL,
	"workspace_snapshot_id" text,
	"permission_policy_ids_json" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"external_identity_ref_json" text,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"runtime_secret_refs_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"capability_flags_json" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_approvers" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text,
	"external_user_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"external_ref_json" text,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"external_ref_json" text,
	"kind" text NOT NULL,
	"title" text,
	"requires_trigger" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_http_response_routes" (
	"session_id" text NOT NULL,
	"thread_id" text DEFAULT '' NOT NULL,
	"response_mode" text NOT NULL,
	"webhook_id" text,
	"correlation_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_http_response_routes_session_id_thread_id_pk" PRIMARY KEY("session_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "control_http_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"default_response_mode" text DEFAULT 'sse' NOT NULL,
	"default_webhook_id" text,
	"external_ref_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_http_sessions_app_id_external_conversation_id_key" UNIQUE("app_id","external_conversation_id")
);
--> statement-breakpoint
CREATE TABLE "control_http_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"event_id" integer NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_http_webhook_deliveries_webhook_id_event_id_key" UNIQUE("webhook_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "control_http_webhooks" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"event_types" text[],
	"agent_id" text,
	"session_id" text,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_http_webhooks_app_id_name_key" UNIQUE("app_id","name")
);
--> statement-breakpoint
CREATE TABLE "event_bus_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"app_id" text NOT NULL,
	"runtime_event_id" integer,
	"correlation_id" text,
	"payload_json" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_bus_outbox_runtime_event_id_key" UNIQUE("runtime_event_id")
);
--> statement-breakpoint
CREATE TABLE "runtime_events" (
	"event_id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runtime_events_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"app_id" text NOT NULL,
	"agent_id" text,
	"session_id" text,
	"run_id" text,
	"job_id" text,
	"trigger_id" text,
	"conversation_id" text,
	"thread_id" text,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"correlation_id" text,
	"response_mode" text,
	"webhook_id" text,
	"payload_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_ingress_invocations" (
	"invocation_id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"ingress_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"nonce" text NOT NULL,
	"request_method" text NOT NULL,
	"request_path" text NOT NULL,
	"request_timestamp" timestamp with time zone NOT NULL,
	"body_hash" text NOT NULL,
	"request_body" text NOT NULL,
	"signature" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_json" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_ingress_invocations_app_id_ingress_id_idempotency_key_key" UNIQUE("app_id","ingress_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "external_ingress_nonces" (
	"app_id" text NOT NULL,
	"ingress_id" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_ingress_nonces_pk" PRIMARY KEY("app_id","ingress_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "external_ingresses" (
	"ingress_id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_ingresses_app_id_name_key" UNIQUE("app_id","name")
);
--> statement-breakpoint
CREATE TABLE "file_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"virtual_scope" text NOT NULL,
	"virtual_path" text NOT NULL,
	"version" integer NOT NULL,
	"storage_type" text NOT NULL,
	"storage_ref" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_by" text,
	"promoted_from_artifact_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runtime_dependencies" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"requested_packages_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_type" text,
	"storage_ref" text,
	"content_hash" text,
	"size_bytes" integer,
	"failure_reason" text,
	"requested_by_agent_id" text,
	"approved_by_conversation_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_revisions" (
	"app_id" text NOT NULL,
	"revision" integer NOT NULL,
	"settings_document_json" jsonb NOT NULL,
	"min_reader_version" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settings_revisions_pk" PRIMARY KEY("app_id","revision")
);
--> statement-breakpoint
CREATE TABLE "group_join_onboarding" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_account" text NOT NULL,
	"chat_jid" text NOT NULL,
	"status" text DEFAULT 'prompted' NOT NULL,
	"adder" text NOT NULL,
	"approver" text NOT NULL,
	"prompt_conversation_jid" text NOT NULL,
	"prompt_agent_folder" text NOT NULL,
	"prompted_at" timestamp with time zone NOT NULL,
	"dismissed_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_join_onboarding_status_check" CHECK ("group_join_onboarding"."status" IN ('prompted', 'dismissed', 'registered'))
);
--> statement-breakpoint
CREATE TABLE "job_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"job_id" text NOT NULL,
	"run_id" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text,
	"conversation_id" text,
	"thread_id" text,
	"created_by_actor_id" text NOT NULL,
	"created_by_source" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"model_override" text,
	"schedule_json" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"target_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"silent" boolean DEFAULT false NOT NULL,
	"timeout_ms" integer DEFAULT 300000 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"retry_backoff_ms" integer DEFAULT 5000 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"lease_run_id" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"job_id" text NOT NULL,
	"agent_run_id" text,
	"status" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"result_summary" text,
	"error_summary" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_admission_work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text,
	"agent_session_id" text,
	"conversation_id" text NOT NULL,
	"thread_id" text,
	"queue_jid" text NOT NULL,
	"message_id" text NOT NULL,
	"message_cursor" text NOT NULL,
	"sender_user_id" text,
	"sender_display_name" text,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"source_kind" text DEFAULT 'message' NOT NULL,
	"trigger_decision_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claim_worker_instance_id" text,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"fencing_version" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"defer_until" timestamp with time zone,
	"deferred_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "live_turn_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"live_turn_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"command_type" text NOT NULL,
	"seq" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"fencing_version" integer,
	"created_by_worker_id" text,
	"applied_by_worker_id" text,
	"rejected_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "live_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"app_id" text NOT NULL,
	"agent_session_id" text,
	"conversation_id" text NOT NULL,
	"thread_id" text,
	"run_id" text,
	"state" text DEFAULT 'claimed' NOT NULL,
	"pending_message_json" jsonb,
	"stop_alias_jids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_continuation_user_id" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_command_seq" integer DEFAULT 1 NOT NULL,
	"worker_instance_id" text,
	"lease_token" text,
	"fencing_version" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"user_id" text,
	"conversation_id" text,
	"thread_id" text,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"source_ref_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"kind" text NOT NULL,
	"content_type" text,
	"size_bytes" integer,
	"external_ref_json" jsonb,
	"storage_ref" text,
	"trust" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_parts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_parts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	CONSTRAINT "message_parts_message_id_ordinal_unique" UNIQUE("message_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"thread_id" text,
	"external_message_id" text,
	"external_ref_json" jsonb,
	"direction" text NOT NULL,
	"sender_user_id" text,
	"sender_display_name" text,
	"trust" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone,
	"delivery_status" text,
	"delivered_at" timestamp with time zone,
	"delivery_error" text
);
--> statement-breakpoint
CREATE TABLE "model_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"auth_mode" text NOT NULL,
	"schema_version" integer NOT NULL,
	"payload_encrypted" text NOT NULL,
	"fingerprint" text NOT NULL,
	"field_fingerprints_json" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_mcp_server_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"permission_policy_ids_json" text DEFAULT '[]' NOT NULL,
	"allowed_tool_patterns_json" text DEFAULT '[]' NOT NULL,
	"conversation_id" text,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_server_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text,
	"server_id" text,
	"binding_id" text,
	"event_type" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_source" text DEFAULT 'admin' NOT NULL,
	"risk_class" text DEFAULT 'medium' NOT NULL,
	"requested_by" text,
	"requested_reason" text,
	"transport" text DEFAULT 'stdio_template' NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"allowed_tool_patterns_json" text DEFAULT '[]' NOT NULL,
	"auto_approve_tool_patterns_json" text DEFAULT '[]' NOT NULL,
	"credential_refs_json" text DEFAULT '[]' NOT NULL,
	"network_hosts_json" text DEFAULT '[]' NOT NULL,
	"sandbox_profile_id" text,
	"disabled_by" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"thread_id" text,
	"agent_id" text,
	"run_id" text,
	"profile_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"idempotency_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"settled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_deliveries_app_id_idempotency_key_key" UNIQUE("app_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "outbound_delivery_final_answers" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"canonical_text" text NOT NULL,
	"segment_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_delivery_items" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"canonical_text" text NOT NULL,
	"provider_payload_json" text,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_delivery_items_delivery_id_ordinal_key" UNIQUE("delivery_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "outbound_delivery_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"item_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_message_id" text,
	"provider_payload_json" text,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_delivery_receipts_item_id_idempotency_key_key" UNIQUE("item_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "pattern_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"folder" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"signature" text NOT NULL,
	"outcome_label" text NOT NULL,
	"short_ask" text NOT NULL,
	"occurrences" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"last_detected_at" timestamp with time zone NOT NULL,
	"candidate_status" text DEFAULT 'detected' NOT NULL,
	"proposal_status" text,
	"snoozed_until" timestamp with time zone,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_surfacing_opt_ins" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"conversation_jid" text,
	"proactive_surfacing_enabled" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"enabled_by_actor_id" text,
	"opted_out_by_actor_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"target_json" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "permission_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"decision_id" text,
	"actor_id" text,
	"event_type" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"policy_id" text,
	"rule_ids_json" text DEFAULT '[]' NOT NULL,
	"run_id" text,
	"tool_id" text,
	"effect" text NOT NULL,
	"reason" text NOT NULL,
	"actor_context_json" text,
	"action_preview" text,
	"approver_ref" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"priority" integer NOT NULL,
	"effect" text NOT NULL,
	"match_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"short_id" integer,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"config_version_id" text NOT NULL,
	"session_id" text,
	"conversation_id" text,
	"thread_id" text,
	"message_id" text,
	"job_id" text,
	"llm_profile_id" text NOT NULL,
	"execution_provider_id" text NOT NULL,
	"provider_run_id" text,
	"provider_session_id" text,
	"worker_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"permission_decision_ids_json" text DEFAULT '[]' NOT NULL,
	"sandbox_lease_id" text,
	"workspace_snapshot_id" text,
	"cause" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"result_summary" text,
	"error_summary" text,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sandbox_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"run_id" text NOT NULL,
	"permission_decision_id" text NOT NULL,
	"status" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sandbox_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"filesystem" text NOT NULL,
	"network" text NOT NULL,
	"process" text NOT NULL,
	"browser" text NOT NULL,
	"credential_access" text NOT NULL,
	"timeout_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"root_ref" text NOT NULL,
	"mounts_json" text DEFAULT '[]' NOT NULL,
	"prompt_refs_json" text DEFAULT '[]' NOT NULL,
	"context_refs_json" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_digests" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_session_id" text NOT NULL,
	"trigger" text NOT NULL,
	"digest" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"extracted_fact_count" integer DEFAULT 0 NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope_app_id" text,
	"scope_agent_id" text,
	"scope_conversation_id" text,
	"scope_user_id" text,
	"scope_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_session_id" text NOT NULL,
	"summary" text NOT NULL,
	"source" text DEFAULT 'extractive' NOT NULL,
	"from_message_id" text,
	"to_message_id" text,
	"from_run_id" text,
	"to_run_id" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text,
	"thread_id" text,
	"job_id" text,
	"user_id" text,
	"scope_key" text,
	"latest_provider_session_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"model_override" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_session_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_session_id" text NOT NULL,
	"sandbox_id" text,
	"workspace_snapshot_id" text,
	"provider_ref_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skill_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"config_version_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text,
	"name" text NOT NULL,
	"description" text,
	"source" text DEFAULT 'bundled' NOT NULL,
	"status" text DEFAULT 'installed' NOT NULL,
	"prompt_refs_json" text DEFAULT '[]' NOT NULL,
	"tool_refs_json" text DEFAULT '[]' NOT NULL,
	"workflow_refs_json" text DEFAULT '[]' NOT NULL,
	"required_env_vars_json" text DEFAULT '[]' NOT NULL,
	"action_permissions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"storage_type" text,
	"storage_ref" text,
	"content_hash" text,
	"size_bytes" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tool_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"config_version_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tool_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'host' NOT NULL,
	"provider" text DEFAULT 'gantry' NOT NULL,
	"provider_tool_name" text,
	"display_name" text DEFAULT '' NOT NULL,
	"description" text,
	"category" text DEFAULT 'admin' NOT NULL,
	"input_schema_json" text DEFAULT '{}' NOT NULL,
	"output_schema_json" text DEFAULT '{}' NOT NULL,
	"risk" text NOT NULL,
	"selectable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"permission_policy_id" text,
	"sandbox_profile_id" text,
	"adapter_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"run_id" text,
	"envelope_id" text,
	"member_index" integer,
	"source_agent_folder" text,
	"request_id" text,
	"run_lease_token" text,
	"run_lease_fencing_version" integer,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload_json" jsonb NOT NULL,
	"callback_route_json" jsonb,
	"idempotency_key" text NOT NULL,
	"approver_ref" text,
	"resolution_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "permission_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"source_agent_folder" text NOT NULL,
	"interaction_id" text NOT NULL,
	"match_kind" text NOT NULL,
	"member_count" integer NOT NULL,
	"rendered_decision_options_json" jsonb NOT NULL,
	"rendered_request_json" jsonb NOT NULL,
	"target_jid" text,
	"approval_context_jid" text,
	"thread_id" text,
	"decision_policy" text,
	"full_view_json" jsonb,
	"external_prompt_provider" text,
	"external_prompt_conversation_id" text,
	"external_prompt_message_id" text,
	"external_prompt_thread_id" text,
	"provider_aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"claim_id" text,
	"claim_mode" text,
	"claim_approver_ref" text,
	"claimed_at" timestamp with time zone,
	"settlement_state" text DEFAULT 'open' NOT NULL,
	"settled_at" timestamp with time zone,
	"canonical_batch_id" text,
	"parent_envelope_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_leases" (
	"run_id" text NOT NULL,
	"job_id" text,
	"worker_instance_id" text NOT NULL,
	"lease_token" text NOT NULL,
	"fencing_version" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_leases_pk" PRIMARY KEY("run_id","fencing_version")
);
--> statement-breakpoint
CREATE TABLE "run_slots" (
	"slot_key" text NOT NULL,
	"holder_id" text NOT NULL,
	"run_id" text,
	"worker_instance_id" text,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_slots_pk" PRIMARY KEY("slot_key","holder_id")
);
--> statement-breakpoint
CREATE TABLE "runner_control_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"job_id" text,
	"worker_instance_id" text NOT NULL,
	"fencing_version" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"exposed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runner_control_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transient_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"run_id" text NOT NULL,
	"lease_token" text NOT NULL,
	"grant_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"image_digest" text,
	"boot_nonce" text NOT NULL,
	"version" text,
	"capabilities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"process_role" text DEFAULT 'all' NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_aliases" ADD CONSTRAINT "user_aliases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_aliases" ADD CONSTRAINT "user_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_llm_profile_id_llm_profiles_id_fk" FOREIGN KEY ("llm_profile_id") REFERENCES "llm_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_sandbox_profile_id_sandbox_profiles_id_fk" FOREIGN KEY ("sandbox_profile_id") REFERENCES "sandbox_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD CONSTRAINT "agent_config_versions_workspace_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("workspace_snapshot_id") REFERENCES "workspace_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_profiles" ADD CONSTRAINT "llm_profiles_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_async_tasks" ADD CONSTRAINT "agent_async_tasks_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_async_tasks" ADD CONSTRAINT "agent_async_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_async_tasks" ADD CONSTRAINT "agent_async_tasks_parent_run_id_agent_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_async_tasks" ADD CONSTRAINT "agent_async_tasks_parent_job_id_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_async_tasks" ADD CONSTRAINT "agent_async_tasks_parent_job_run_id_job_runs_id_fk" FOREIGN KEY ("parent_job_run_id") REFERENCES "job_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_dream_decisions" ADD CONSTRAINT "brain_dream_decisions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_dream_decisions" ADD CONSTRAINT "brain_dream_decisions_page_id_brain_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "brain_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_dream_state" ADD CONSTRAINT "brain_dream_state_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_edges" ADD CONSTRAINT "brain_edges_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_edges" ADD CONSTRAINT "brain_edges_from_entity_id_brain_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "brain_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_edges" ADD CONSTRAINT "brain_edges_to_entity_id_brain_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "brain_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_edges" ADD CONSTRAINT "brain_edges_evidence_page_id_brain_pages_id_fk" FOREIGN KEY ("evidence_page_id") REFERENCES "brain_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_entities" ADD CONSTRAINT "brain_entities_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_page_embeddings" ADD CONSTRAINT "brain_page_embeddings_page_id_brain_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "brain_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_pages" ADD CONSTRAINT "brain_pages_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_snapshot_run_id_agent_runs_id_fk" FOREIGN KEY ("snapshot_run_id") REFERENCES "agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_secrets" ADD CONSTRAINT "capability_secrets_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_installs" ADD CONSTRAINT "conversation_installs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_installs" ADD CONSTRAINT "conversation_installs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_installs" ADD CONSTRAINT "conversation_installs_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_installs" ADD CONSTRAINT "conversation_installs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_installs" ADD CONSTRAINT "conversation_installs_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_installs" ADD CONSTRAINT "conversation_installs_workspace_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("workspace_snapshot_id") REFERENCES "workspace_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD CONSTRAINT "conversation_approvers_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD CONSTRAINT "conversation_approvers_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_http_response_routes" ADD CONSTRAINT "control_http_response_routes_session_id_control_http_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "control_http_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_http_sessions" ADD CONSTRAINT "control_http_sessions_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_http_sessions" ADD CONSTRAINT "control_http_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_http_sessions" ADD CONSTRAINT "control_http_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_http_sessions" ADD CONSTRAINT "control_http_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_http_webhook_deliveries" ADD CONSTRAINT "control_http_webhook_deliveries_webhook_id_control_http_webhooks_webhook_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "control_http_webhooks"("webhook_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_http_webhook_deliveries" ADD CONSTRAINT "control_http_webhook_deliveries_event_id_runtime_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "runtime_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_http_webhooks" ADD CONSTRAINT "control_http_webhooks_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bus_outbox" ADD CONSTRAINT "event_bus_outbox_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_bus_outbox" ADD CONSTRAINT "event_bus_outbox_runtime_event_id_runtime_events_event_id_fk" FOREIGN KEY ("runtime_event_id") REFERENCES "runtime_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "conversation_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ingress_invocations" ADD CONSTRAINT "external_ingress_invocations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ingress_invocations" ADD CONSTRAINT "external_ingress_invocations_ingress_id_external_ingresses_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "external_ingresses"("ingress_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ingress_nonces" ADD CONSTRAINT "external_ingress_nonces_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ingress_nonces" ADD CONSTRAINT "external_ingress_nonces_ingress_id_external_ingresses_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "external_ingresses"("ingress_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ingresses" ADD CONSTRAINT "external_ingresses_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_artifacts" ADD CONSTRAINT "file_artifacts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_artifacts" ADD CONSTRAINT "file_artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_artifacts" ADD CONSTRAINT "file_artifacts_promoted_from_artifact_id_file_artifacts_id_fk" FOREIGN KEY ("promoted_from_artifact_id") REFERENCES "file_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_dependencies" ADD CONSTRAINT "runtime_dependencies_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_revisions" ADD CONSTRAINT "settings_revisions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_onboarding" ADD CONSTRAINT "group_join_onboarding_provider_account_provider_accounts_id_fk" FOREIGN KEY ("provider_account") REFERENCES "provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triggers" ADD CONSTRAINT "job_triggers_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triggers" ADD CONSTRAINT "job_triggers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_triggers" ADD CONSTRAINT "job_triggers_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_lease_run_id_agent_runs_id_fk" FOREIGN KEY ("lease_run_id") REFERENCES "agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_turn_commands" ADD CONSTRAINT "live_turn_commands_live_turn_id_live_turns_id_fk" FOREIGN KEY ("live_turn_id") REFERENCES "live_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_turns" ADD CONSTRAINT "live_turns_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_parts" ADD CONSTRAINT "message_parts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_credentials" ADD CONSTRAINT "model_credentials_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_server_bindings" ADD CONSTRAINT "agent_mcp_server_bindings_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_server_bindings" ADD CONSTRAINT "agent_mcp_server_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_server_bindings" ADD CONSTRAINT "agent_mcp_server_bindings_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_audit_events" ADD CONSTRAINT "mcp_server_audit_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_audit_events" ADD CONSTRAINT "mcp_server_audit_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_audit_events" ADD CONSTRAINT "mcp_server_audit_events_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "mcp_servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_audit_events" ADD CONSTRAINT "mcp_server_audit_events_binding_id_agent_mcp_server_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "agent_mcp_server_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_delivery_final_answers" ADD CONSTRAINT "outbound_delivery_final_answers_delivery_id_outbound_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "outbound_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_delivery_items" ADD CONSTRAINT "outbound_delivery_items_delivery_id_outbound_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "outbound_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_delivery_receipts" ADD CONSTRAINT "outbound_delivery_receipts_delivery_id_outbound_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "outbound_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_delivery_receipts" ADD CONSTRAINT "outbound_delivery_receipts_item_id_outbound_delivery_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "outbound_delivery_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_candidates" ADD CONSTRAINT "pattern_candidates_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_surfacing_opt_ins" ADD CONSTRAINT "proactive_surfacing_opt_ins_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_access_requests" ADD CONSTRAINT "pending_access_requests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_audit_events" ADD CONSTRAINT "permission_audit_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_audit_events" ADD CONSTRAINT "permission_audit_events_decision_id_permission_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "permission_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_decisions" ADD CONSTRAINT "permission_decisions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_decisions" ADD CONSTRAINT "permission_decisions_policy_id_permission_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "permission_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_decisions" ADD CONSTRAINT "permission_decisions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_decisions" ADD CONSTRAINT "permission_decisions_tool_id_tool_catalog_id_fk" FOREIGN KEY ("tool_id") REFERENCES "tool_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_policies" ADD CONSTRAINT "permission_policies_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD CONSTRAINT "permission_rules_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD CONSTRAINT "permission_rules_policy_id_permission_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "permission_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_config_version_id_agent_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "agent_config_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_llm_profile_id_llm_profiles_id_fk" FOREIGN KEY ("llm_profile_id") REFERENCES "llm_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD CONSTRAINT "sandbox_leases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD CONSTRAINT "sandbox_leases_profile_id_sandbox_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "sandbox_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD CONSTRAINT "sandbox_leases_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_leases" ADD CONSTRAINT "sandbox_leases_permission_decision_id_permission_decisions_id_fk" FOREIGN KEY ("permission_decision_id") REFERENCES "permission_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_profiles" ADD CONSTRAINT "sandbox_profiles_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_digests" ADD CONSTRAINT "agent_session_digests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_digests" ADD CONSTRAINT "agent_session_digests_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_summaries" ADD CONSTRAINT "agent_session_summaries_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_summaries" ADD CONSTRAINT "agent_session_summaries_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "conversation_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_sessions" ADD CONSTRAINT "provider_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_sessions" ADD CONSTRAINT "provider_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_sessions" ADD CONSTRAINT "provider_sessions_sandbox_id_sandbox_profiles_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "sandbox_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_sessions" ADD CONSTRAINT "provider_sessions_workspace_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("workspace_snapshot_id") REFERENCES "workspace_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_bindings" ADD CONSTRAINT "agent_skill_bindings_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_bindings" ADD CONSTRAINT "agent_skill_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_bindings" ADD CONSTRAINT "agent_skill_bindings_skill_id_skill_catalog_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skill_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_catalog" ADD CONSTRAINT "skill_catalog_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_catalog" ADD CONSTRAINT "skill_catalog_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "agent_tool_bindings_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "agent_tool_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "agent_tool_bindings_tool_id_tool_catalog_id_fk" FOREIGN KEY ("tool_id") REFERENCES "tool_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_sources" ADD CONSTRAINT "agent_tool_sources_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_sources" ADD CONSTRAINT "agent_tool_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_catalog" ADD CONSTRAINT "tool_catalog_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD CONSTRAINT "pending_interactions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD CONSTRAINT "pending_interactions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD CONSTRAINT "pending_interactions_envelope_id_permission_prompts_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "permission_prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_prompts" ADD CONSTRAINT "permission_prompts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_prompts" ADD CONSTRAINT "permission_prompts_parent_envelope_id_permission_prompts_id_fk" FOREIGN KEY ("parent_envelope_id") REFERENCES "permission_prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_leases" ADD CONSTRAINT "run_leases_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_leases" ADD CONSTRAINT "run_leases_worker_instance_id_worker_instances_id_fk" FOREIGN KEY ("worker_instance_id") REFERENCES "worker_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_control_events" ADD CONSTRAINT "runner_control_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transient_grants" ADD CONSTRAINT "transient_grants_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transient_grants" ADD CONSTRAINT "transient_grants_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_candidates_boundary" ON "memory_candidates" USING btree ("app_id","agent_id","subject_type","subject_id","status","confidence","updated_at");--> statement-breakpoint
CREATE INDEX "idx_memory_dream_decisions_run" ON "memory_dream_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_memory_dream_decisions_app" ON "memory_dream_decisions" USING btree ("app_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_dream_runs_boundary" ON "memory_dream_runs" USING btree ("app_id","agent_id","subject_type","subject_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_dream_runs_running_light_unique" ON "memory_dream_runs" USING btree ("app_id","agent_id","subject_type","subject_id",('light'::text)) WHERE "memory_dream_runs"."status" = 'running' AND "memory_dream_runs"."phase" IN ('all', 'light');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_dream_runs_running_rem_unique" ON "memory_dream_runs" USING btree ("app_id","agent_id","subject_type","subject_id",('rem'::text)) WHERE "memory_dream_runs"."status" = 'running' AND "memory_dream_runs"."phase" IN ('all', 'rem');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_dream_runs_running_deep_unique" ON "memory_dream_runs" USING btree ("app_id","agent_id","subject_type","subject_id",('deep'::text)) WHERE "memory_dream_runs"."status" = 'running' AND "memory_dream_runs"."phase" IN ('all', 'deep');--> statement-breakpoint
CREATE INDEX "idx_memory_embedding_backfill_runs_scope" ON "memory_embedding_backfill_runs" USING btree ("app_id","agent_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_memory_embedding_backfill_runs_status" ON "memory_embedding_backfill_runs" USING btree ("status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memory_embedding_backfill_runs_running" ON "memory_embedding_backfill_runs" USING btree ("app_id",(coalesce("agent_id", ''))) WHERE status = 'running' AND mode = 'inline';--> statement-breakpoint
CREATE INDEX "idx_memory_evidence_boundary" ON "memory_evidence" USING btree ("app_id","agent_id","subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_evidence_search" ON "memory_evidence" USING gin (to_tsvector('english', "text"));--> statement-breakpoint
CREATE INDEX "idx_memory_item_embeddings_item" ON "memory_item_embeddings" USING btree ("item_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_memory_item_embeddings_status" ON "memory_item_embeddings" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_memory_item_embeddings_resume" ON "memory_item_embeddings" USING btree ("status","resume_after");--> statement-breakpoint
CREATE INDEX "idx_memory_item_embeddings_provider_batch" ON "memory_item_embeddings" USING btree ("provider","model","status","provider_batch_id","updated_at","item_id");--> statement-breakpoint
CREATE INDEX "idx_memory_item_embeddings_ready_lookup" ON "memory_item_embeddings" USING btree ("provider","model","dimensions","status","item_id") WHERE status = 'ready' AND embedding IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_memory_item_embeddings_hnsw" ON "memory_item_embeddings" USING hnsw ("embedding" vector_cosine_ops) WHERE status = 'ready' AND embedding IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_memory_recall_events_item" ON "memory_recall_events" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_recall_events_app" ON "memory_recall_events" USING btree ("app_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_review_requests_pending_boundary" ON "memory_review_requests" USING btree ("app_id","agent_id","subject_type","subject_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_review_requests_run" ON "memory_review_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_memory_review_requests_content_hash" ON "memory_review_requests" USING btree ("app_id","agent_id","subject_type","subject_id","flagged_content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_aliases_provider_external" ON "user_aliases" USING btree ("app_id","provider","provider_account_id","external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_app_display_name" ON "users" USING btree ("app_id","display_name");--> statement-breakpoint
CREATE INDEX "idx_agent_async_tasks_app_status_updated" ON "agent_async_tasks" USING btree ("app_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_agent_async_tasks_scope_updated" ON "agent_async_tasks" USING btree ("app_id","agent_id","conversation_id","thread_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_agent_async_tasks_parent_run" ON "agent_async_tasks" USING btree ("parent_run_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_agent_async_tasks_parent_job_run" ON "agent_async_tasks" USING btree ("parent_job_run_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_brain_dream_decisions_run" ON "brain_dream_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_brain_dream_decisions_app" ON "brain_dream_decisions" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_brain_edges_page" ON "brain_edges" USING btree ("app_id","evidence_page_id");--> statement-breakpoint
CREATE INDEX "idx_brain_edges_from" ON "brain_edges" USING btree ("app_id","from_entity_id");--> statement-breakpoint
CREATE INDEX "idx_brain_edges_to" ON "brain_edges" USING btree ("app_id","to_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_brain_edges_unique" ON "brain_edges" USING btree ("app_id","type","from_entity_id","to_entity_id","evidence_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_brain_entities_app_kind_name_unique" ON "brain_entities" USING btree ("app_id","kind","normalized_name");--> statement-breakpoint
CREATE INDEX "idx_brain_entities_lookup" ON "brain_entities" USING btree ("app_id","kind","normalized_name");--> statement-breakpoint
CREATE INDEX "idx_brain_page_embeddings_status" ON "brain_page_embeddings" USING btree ("status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_brain_page_embeddings_ready_lookup" ON "brain_page_embeddings" USING btree ("provider","model","dimensions","status","page_id") WHERE status = 'ready' AND embedding IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_brain_page_embeddings_hnsw" ON "brain_page_embeddings" USING hnsw ("embedding" vector_cosine_ops) WHERE status = 'ready' AND embedding IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_brain_pages_app_slug_unique" ON "brain_pages" USING btree ("app_id","slug");--> statement-breakpoint
CREATE INDEX "idx_brain_pages_app_updated" ON "brain_pages" USING btree ("app_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_brain_pages_search" ON "brain_pages" USING gin (to_tsvector('english', "title" || ' ' || "markdown"));--> statement-breakpoint
CREATE INDEX "idx_browser_profiles_app" ON "browser_profiles" USING btree ("app_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_capability_secrets_app_name" ON "capability_secrets" USING btree ("app_id","name");--> statement-breakpoint
CREATE INDEX "idx_capability_secrets_app_updated" ON "capability_secrets" USING btree ("app_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_conversation_installs_conversation" ON "conversation_installs" USING btree ("conversation_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_installs_account" ON "conversation_installs" USING btree ("provider_account_id");--> statement-breakpoint
CREATE INDEX "idx_provider_accounts_provider" ON "provider_accounts" USING btree ("app_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_provider_accounts_agent" ON "provider_accounts" USING btree ("app_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_provider_accounts_active_identity" ON "provider_accounts" USING btree ("app_id","provider_id","external_identity_ref_json") WHERE "provider_accounts"."status" = 'active' AND "provider_accounts"."external_identity_ref_json" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_conversation_approvers_conversation" ON "conversation_approvers" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_conversation_approvers_user" ON "conversation_approvers" USING btree ("app_id","conversation_id","external_user_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_participants_conversation" ON "conversation_participants" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_threads_conversation" ON "conversation_threads" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_provider_account" ON "conversations" USING btree ("provider_account_id");--> statement-breakpoint
CREATE INDEX "idx_control_http_sessions_chat_jid" ON "control_http_sessions" USING btree (("external_ref_json"->>'chatJid'));--> statement-breakpoint
CREATE INDEX "idx_control_http_webhook_deliveries_due" ON "control_http_webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_control_http_webhooks_subscription_app" ON "control_http_webhooks" USING btree ("app_id","enabled") WHERE "control_http_webhooks"."event_types" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_event_bus_outbox_claim_due" ON "event_bus_outbox" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_event_bus_outbox_app_event" ON "event_bus_outbox" USING btree ("app_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_event_bus_outbox_runtime_event" ON "event_bus_outbox" USING btree ("runtime_event_id");--> statement-breakpoint
CREATE INDEX "idx_event_bus_outbox_pending_runtime_event" ON "event_bus_outbox" USING btree ("runtime_event_id") WHERE "event_bus_outbox"."runtime_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runtime_events_app_cursor" ON "runtime_events" USING btree ("app_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_session_cursor" ON "runtime_events" USING btree ("app_id","session_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_run_cursor" ON "runtime_events" USING btree ("app_id","run_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_job_cursor" ON "runtime_events" USING btree ("app_id","job_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_trigger_cursor" ON "runtime_events" USING btree ("app_id","trigger_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_conversation_thread_cursor" ON "runtime_events" USING btree ("app_id","conversation_id","thread_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_type_cursor" ON "runtime_events" USING btree ("app_id","event_type","event_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_usage_query" ON "runtime_events" USING btree ("app_id","event_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_webhook_projection" ON "runtime_events" USING btree ("app_id","webhook_id","response_mode","event_id");--> statement-breakpoint
CREATE INDEX "idx_external_ingress_invocations_app_created" ON "external_ingress_invocations" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_external_ingress_invocations_ingress_status_created" ON "external_ingress_invocations" USING btree ("ingress_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_external_ingress_invocations_expires" ON "external_ingress_invocations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_external_ingress_nonces_expiry" ON "external_ingress_nonces" USING btree ("app_id","ingress_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_external_ingress_nonces_expires" ON "external_ingress_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_external_ingresses_app_enabled" ON "external_ingresses" USING btree ("app_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_file_artifacts_version_unique" ON "file_artifacts" USING btree ("app_id","agent_id","virtual_scope","virtual_path","version");--> statement-breakpoint
CREATE INDEX "idx_file_artifacts_scope" ON "file_artifacts" USING btree ("app_id","agent_id","virtual_scope","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_dependencies_app_manifest" ON "runtime_dependencies" USING btree ("app_id","manifest_hash");--> statement-breakpoint
CREATE INDEX "idx_runtime_dependencies_app_status" ON "runtime_dependencies" USING btree ("app_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_settings_revisions_app_created" ON "settings_revisions" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "group_join_onboarding_provider_chat_unique" ON "group_join_onboarding" USING btree ("provider_account","chat_jid");--> statement-breakpoint
CREATE INDEX "idx_group_join_onboarding_status" ON "group_join_onboarding" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_jobs_app_status_next_run" ON "jobs" USING btree ("app_id","status","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_target_session_updated" ON "jobs" USING btree (("target_json" #>> '{executionContext,sessionId}'),"updated_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_jobs_target_workspace_key_updated" ON "jobs" USING btree (("target_json" #>> '{executionContext,workspaceKey}'),"updated_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_jobs_target_thread_normalized_updated" ON "jobs" USING btree (coalesce("target_json" #>> '{executionContext,threadId}', ''),"updated_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_jobs_target_notification_routes" ON "jobs" USING gin ((coalesce("target_json" -> 'notificationRoutes', '[]'::jsonb)) jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "idx_job_runs_job" ON "job_runs" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_live_admission_work_items_idempotency" ON "live_admission_work_items" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_live_admission_work_items_queued_fifo" ON "live_admission_work_items" USING btree ("app_id","created_at","id") WHERE "live_admission_work_items"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_live_admission_work_items_deferred_due" ON "live_admission_work_items" USING btree ("app_id","defer_until","created_at","id") WHERE "live_admission_work_items"."state" = 'deferred' AND "live_admission_work_items"."defer_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_live_admission_work_items_deferred_null_fifo" ON "live_admission_work_items" USING btree ("app_id","created_at","id") WHERE "live_admission_work_items"."state" = 'deferred' AND "live_admission_work_items"."defer_until" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_live_admission_work_items_claimed_expired" ON "live_admission_work_items" USING btree ("app_id","claim_expires_at","created_at","id") WHERE "live_admission_work_items"."state" = 'claimed' AND "live_admission_work_items"."claim_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_live_turn_commands_idempotency" ON "live_turn_commands" USING btree ("live_turn_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_live_turn_commands_turn_seq" ON "live_turn_commands" USING btree ("live_turn_id","seq");--> statement-breakpoint
CREATE INDEX "idx_live_turn_commands_pending" ON "live_turn_commands" USING btree ("live_turn_id","seq") WHERE "live_turn_commands"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_live_turns_active_scope" ON "live_turns" USING btree ("scope_key") WHERE "live_turns"."state" NOT IN ('completed', 'failed', 'timed_out');--> statement-breakpoint
CREATE INDEX "idx_live_turns_scope" ON "live_turns" USING btree ("scope_key","created_at");--> statement-breakpoint
CREATE INDEX "idx_live_turns_run" ON "live_turns" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_live_turns_state" ON "live_turns" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "idx_live_turns_recoverable_leased" ON "live_turns" USING btree ("updated_at","id","run_id") WHERE "live_turns"."state" NOT IN ('completed', 'failed', 'timed_out')
          AND "live_turns"."run_id" IS NOT NULL
          AND "live_turns"."lease_token" IS NOT NULL
          AND "live_turns"."fencing_version" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_live_turns_recoverable_unleased" ON "live_turns" USING btree ("updated_at","id") WHERE "live_turns"."state" NOT IN ('completed', 'failed', 'timed_out')
          AND "live_turns"."lease_token" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_items_active_unique" ON "memory_items" USING btree ("app_id","agent_id","subject_type","subject_id","kind","key") WHERE "memory_items"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_memory_items_subject_updated" ON "memory_items" USING btree ("app_id","agent_id","subject_type","subject_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_memory_items_search" ON "memory_items" USING gin (to_tsvector('english', "key" || ' ' || COALESCE("value_json"->>'value', '') || ' ' || COALESCE("value_json"->>'why', '')));--> statement-breakpoint
CREATE INDEX "idx_message_attachments_message_id" ON "message_attachments" USING btree ("message_id","id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_cursor" ON "messages" USING btree ("conversation_id","thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_recent" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messages_external_redelivery_unique" ON "messages" USING btree ("provider","provider_account_id","conversation_id",COALESCE("thread_id", ''),"external_message_id") WHERE "messages"."external_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_credentials_app_provider" ON "model_credentials" USING btree ("app_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_model_credentials_app_updated" ON "model_credentials" USING btree ("app_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_mcp_server_bindings_unique" ON "agent_mcp_server_bindings" USING btree ("app_id","agent_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_agent_mcp_server_bindings_agent_status" ON "agent_mcp_server_bindings" USING btree ("app_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_mcp_server_audit_events_app_server_created" ON "mcp_server_audit_events" USING btree ("app_id","server_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_mcp_server_audit_events_app_created" ON "mcp_server_audit_events" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mcp_servers_app_name" ON "mcp_servers" USING btree ("app_id","name");--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_app_status_updated" ON "mcp_servers" USING btree ("app_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_outbound_deliveries_app_status_updated" ON "outbound_deliveries" USING btree ("app_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_outbound_deliveries_app_profile_status_updated" ON "outbound_deliveries" USING btree ("app_id","profile_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_outbound_deliveries_conversation_updated" ON "outbound_deliveries" USING btree ("conversation_id","thread_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_outbound_delivery_items_claim_due" ON "outbound_delivery_items" USING btree ("status","next_attempt_at","claim_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_outbound_delivery_items_claimed_expired" ON "outbound_delivery_items" USING btree ("claim_expires_at","updated_at","id") WHERE "outbound_delivery_items"."status" = 'claimed' AND "outbound_delivery_items"."claim_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_outbound_delivery_items_delivery_status" ON "outbound_delivery_items" USING btree ("delivery_id","status","ordinal");--> statement-breakpoint
CREATE INDEX "idx_outbound_delivery_receipts_delivery_sent" ON "outbound_delivery_receipts" USING btree ("delivery_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pattern_candidates_signature_unique" ON "pattern_candidates" USING btree ("app_id","agent_id","subject_type","subject_id","signature");--> statement-breakpoint
CREATE INDEX "idx_pattern_candidates_eligible" ON "pattern_candidates" USING btree ("app_id","agent_id","subject_type","subject_id","candidate_status");--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_surfacing_opt_ins_subject_unique" ON "proactive_surfacing_opt_ins" USING btree ("app_id","agent_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_pending_access_requests_app_status" ON "pending_access_requests" USING btree ("app_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_job_started" ON "agent_runs" USING btree ("job_id","started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_runs_job_short_id_unique" ON "agent_runs" USING btree ("job_id","short_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_started_created" ON "agent_runs" USING btree ("started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_agent_runs_provider_session" ON "agent_runs" USING btree ("provider_session_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_lease_claim" ON "agent_runs" USING btree ("status","lease_expires_at","lease_owner") WHERE "agent_runs"."status" IN ('pending', 'leased');--> statement-breakpoint
CREATE INDEX "idx_agent_session_digests_session_created" ON "agent_session_digests" USING btree ("agent_session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_agent_session_digests_session_trigger" ON "agent_session_digests" USING btree ("agent_session_id","trigger","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_session_digests_scope_created" ON "agent_session_digests" USING btree ("agent_session_id","scope_app_id","scope_agent_id","scope_conversation_id","scope_user_id","scope_thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_agent_session_summaries_session_created" ON "agent_session_summaries" USING btree ("agent_session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_owner" ON "agent_sessions" USING btree ("app_id","agent_id","conversation_id","thread_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_app_scope_key" ON "agent_sessions" USING btree ("app_id","scope_key");--> statement-breakpoint
CREATE INDEX "idx_provider_sessions_external" ON "provider_sessions" USING btree ("provider","external_session_id");--> statement-breakpoint
CREATE INDEX "idx_provider_sessions_resume_lookup" ON "provider_sessions" USING btree ("agent_session_id","provider","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_provider_sessions_agent_provider" ON "provider_sessions" USING btree ("agent_session_id","provider");--> statement-breakpoint
CREATE INDEX "idx_provider_sessions_agent_status_updated" ON "provider_sessions" USING btree ("agent_session_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_skill_bindings_unique" ON "agent_skill_bindings" USING btree ("app_id","agent_id","skill_id");--> statement-breakpoint
CREATE INDEX "idx_skill_catalog_app_status" ON "skill_catalog" USING btree ("app_id","status");--> statement-breakpoint
CREATE INDEX "idx_skill_catalog_app_agent_status" ON "skill_catalog" USING btree ("app_id","agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_skill_catalog_app_skill_slug_installed" ON "skill_catalog" USING btree ("app_id",lower(regexp_replace(regexp_replace(trim("name"), '[^A-Za-z0-9._-]+', '-', 'g'), '-+', '-', 'g'))) WHERE "skill_catalog"."status" = 'installed';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_tool_bindings_unique" ON "agent_tool_bindings" USING btree ("agent_id","tool_id","config_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_tool_sources_unique" ON "agent_tool_sources" USING btree ("app_id","agent_id","source_id","kind","version");--> statement-breakpoint
CREATE INDEX "idx_agent_tool_sources_app_agent_status" ON "agent_tool_sources" USING btree ("app_id","agent_id","status","source_id","kind","version","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tool_catalog_app_name" ON "tool_catalog" USING btree ("app_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pending_interactions_idempotency" ON "pending_interactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_pending_interactions_app_status" ON "pending_interactions" USING btree ("app_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_pending_interactions_run" ON "pending_interactions" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "idx_pending_interactions_request_lookup" ON "pending_interactions" USING btree ("app_id","kind","source_agent_folder","request_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pending_interactions_envelope_member" ON "pending_interactions" USING btree ("envelope_id","member_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pending_interactions_envelope_request" ON "pending_interactions" USING btree ("envelope_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_pending_interactions_envelope_status" ON "pending_interactions" USING btree ("envelope_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_permission_prompts_scope" ON "permission_prompts" USING btree ("app_id","source_agent_folder","interaction_id","settlement_state");--> statement-breakpoint
CREATE INDEX "idx_permission_prompts_message" ON "permission_prompts" USING btree ("app_id","external_prompt_provider","external_prompt_conversation_id","external_prompt_message_id","external_prompt_thread_id");--> statement-breakpoint
CREATE INDEX "idx_permission_prompts_parent" ON "permission_prompts" USING btree ("parent_envelope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_leases_lease_token" ON "run_leases" USING btree ("lease_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_leases_active_run" ON "run_leases" USING btree ("run_id") WHERE "run_leases"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_leases_active_job" ON "run_leases" USING btree ("job_id") WHERE "run_leases"."status" = 'active' AND "run_leases"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_run_leases_status_expires" ON "run_leases" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_run_leases_worker" ON "run_leases" USING btree ("worker_instance_id","status");--> statement-breakpoint
CREATE INDEX "idx_run_slots_expires" ON "run_slots" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_runner_control_events_run" ON "runner_control_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runner_control_events_unexposed" ON "runner_control_events" USING btree ("created_at") WHERE "runner_control_events"."exposed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_runner_control_nonces_expires" ON "runner_control_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_transient_grants_run" ON "transient_grants" USING btree ("run_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_worker_instances_status_heartbeat" ON "worker_instances" USING btree ("status","heartbeat_at");
--> statement-breakpoint
ALTER TABLE "event_bus_outbox" ADD CONSTRAINT "event_bus_outbox_event_version_check" CHECK ("event_version" > 0);
--> statement-breakpoint
ALTER TABLE "event_bus_outbox" ADD CONSTRAINT "event_bus_outbox_status_check" CHECK ("status" IN ('pending', 'published', 'failed'));
--> statement-breakpoint
ALTER TABLE "event_bus_outbox" ADD CONSTRAINT "event_bus_outbox_attempt_count_check" CHECK ("attempt_count" >= 0);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_execution_provider_id_safe" CHECK (
	"execution_provider_id" IS NOT NULL
	AND "execution_provider_id" !~ '^unconfigured:'
	AND "execution_provider_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$'
);
--> statement-breakpoint
ALTER TABLE "llm_profiles" ADD CONSTRAINT "llm_profiles_response_family_valid" CHECK ("response_family" IN ('anthropic', 'openai'));
--> statement-breakpoint
ALTER TABLE "control_http_webhooks" ADD CONSTRAINT "control_http_webhooks_event_types_nonempty_check" CHECK ("event_types" IS NULL OR cardinality("event_types") > 0);
--> statement-breakpoint
ALTER TABLE "control_http_webhooks" ADD CONSTRAINT "control_http_webhooks_subject_requires_events_check" CHECK (
	"event_types" IS NOT NULL
	OR ("agent_id" IS NULL AND "session_id" IS NULL AND "job_id" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_sessions_deterministic_key" ON "agent_sessions" USING btree (
	"app_id",
	"agent_id",
	coalesce("conversation_id", ''),
	coalesce("thread_id", ''),
	coalesce("user_id", '')
) WHERE "agent_sessions"."job_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_app_scope_key_prefix" ON "agent_sessions" USING btree ("app_id","scope_key" text_pattern_ops);
--> statement-breakpoint
CREATE INDEX "idx_agent_runs_session_created" ON "agent_runs" USING btree ("session_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "idx_messages_delivery_status" ON "messages" USING btree ("delivery_status","delivered_at");
--> statement-breakpoint
CREATE INDEX "idx_conversation_installs_agent_conversation" ON "conversation_installs" USING btree ("app_id","agent_id","conversation_id","thread_id");
