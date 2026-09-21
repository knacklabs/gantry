CREATE TABLE "agent_conversation_allowlist" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"person_id" text,
	"alias_id" text,
	"external_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_conversation_allowlist" ADD CONSTRAINT "agent_conversation_allowlist_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversation_allowlist" ADD CONSTRAINT "agent_conversation_allowlist_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversation_allowlist" ADD CONSTRAINT "agent_conversation_allowlist_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversation_allowlist" ADD CONSTRAINT "agent_conversation_allowlist_app_user_fk" FOREIGN KEY ("app_id","person_id") REFERENCES "users"("app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversation_allowlist" ADD CONSTRAINT "agent_conversation_allowlist_alias_fk" FOREIGN KEY ("alias_id") REFERENCES "user_aliases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_conversation_allowlist_conversation" ON "agent_conversation_allowlist" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_agent_conversation_allowlist_user" ON "agent_conversation_allowlist" USING btree ("app_id","agent_id","conversation_id","external_user_id");