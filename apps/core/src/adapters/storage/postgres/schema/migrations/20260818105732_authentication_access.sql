CREATE TABLE "browser_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_hash" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"reauthenticated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_sessions_session_hash_unique" UNIQUE("session_hash")
);
--> statement-breakpoint
CREATE TABLE "console_access_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"status" text DEFAULT 'awaiting_approval' NOT NULL,
	"access_reference_hash" text,
	"access_reference_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "console_access_grants_role_check" CHECK ("console_access_grants"."role" IN ('administrator', 'viewer')),
	CONSTRAINT "console_access_grants_status_check" CHECK ("console_access_grants"."status" IN ('awaiting_approval', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "console_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_email" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "console_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "console_invitations_role_check" CHECK ("console_invitations"."role" IN ('administrator', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "local_authorization_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"canonical_host" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"encrypted_pkce_verifier" text NOT NULL,
	"oidc_config_json" text,
	"configuration_test" boolean DEFAULT false NOT NULL,
	"invitation_token_hash" text,
	"reauthenticate_user_id" text,
	"reauthenticate_session_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_transactions_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_access_grants" ADD CONSTRAINT "console_access_grants_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_access_grants" ADD CONSTRAINT "console_access_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_invitations" ADD CONSTRAINT "console_invitations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_authorization_codes" ADD CONSTRAINT "local_authorization_codes_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_authorization_codes" ADD CONSTRAINT "local_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_transactions" ADD CONSTRAINT "oidc_transactions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "console_access_grants_app_user_unique" ON "console_access_grants" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE INDEX "console_access_grants_active_admin_idx" ON "console_access_grants" USING btree ("app_id","status","role");--> statement-breakpoint
CREATE UNIQUE INDEX "console_access_grants_access_reference_unique" ON "console_access_grants" USING btree ("access_reference_hash") WHERE "console_access_grants"."access_reference_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "local_authorization_codes_token_unique" ON "local_authorization_codes" USING btree ("token_hash");
