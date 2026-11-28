DROP INDEX "channels_name_uq";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "channel_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_name_uq" ON "channels" USING btree ("workspace_id","name") WHERE kind = 'channel' and archived_at is null;