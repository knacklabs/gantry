CREATE SEQUENCE "live_admission_receive_order_seq";--> statement-breakpoint
ALTER TABLE "live_admission_work_items" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "live_admission_work_items" ADD COLUMN "receive_order" bigint DEFAULT nextval('live_admission_receive_order_seq'::regclass);--> statement-breakpoint
ALTER TABLE "live_admission_work_items" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "live_admission_work_items" ADD COLUMN "consumed_by" text;--> statement-breakpoint
CREATE INDEX "idx_live_admission_work_items_unconsumed" ON "live_admission_work_items" USING btree ("queue_jid","receive_order") WHERE "live_admission_work_items"."consumed_at" IS NULL;
