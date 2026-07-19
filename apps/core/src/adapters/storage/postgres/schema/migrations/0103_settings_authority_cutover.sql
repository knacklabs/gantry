ALTER TABLE "conversations" ADD COLUMN "requires_trigger" boolean;--> statement-breakpoint
UPDATE "conversations" SET "requires_trigger" = CASE WHEN "kind" = 'direct' THEN false ELSE true END;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "requires_trigger" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "requires_trigger" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_installs" DROP COLUMN "sender_policy";--> statement-breakpoint
ALTER TABLE "conversation_installs" DROP COLUMN "control_policy";
