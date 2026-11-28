DROP INDEX "channels_name_uq";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "channel_id" text;--> statement-breakpoint
-- A lesson from feedback given in a private channel or a DM stays in that channel: the ones learned before this
-- column are confined by the channel of their feedback message. Only those: no other row's channel is guessed.
UPDATE "memories" AS m SET "channel_id" = msg."channel_id"
  FROM "messages" AS msg JOIN "channels" AS ch ON ch."id" = msg."channel_id"
  WHERE m."source" = 'feedback' AND m."channel_id" IS NULL AND m."origin_message_id" = msg."id"
    AND (ch."kind" = 'dm' OR ch."visibility" = 'private');--> statement-breakpoint
-- A private channel's debate is read only by the channel's members now: its indexed chunks keep the agents at the
-- table as readers from outside, and no longer the people (the next reindex writes the same).
UPDATE "search_chunks" SET "principals" = ARRAY(SELECT p FROM unnest("principals") AS p WHERE p NOT LIKE 'user:%')
  WHERE "source_kind" = 'debate' AND EXISTS (SELECT 1 FROM unnest("principals") AS p WHERE p LIKE 'user:%');--> statement-breakpoint
CREATE UNIQUE INDEX "channels_name_uq" ON "channels" USING btree ("workspace_id","name") WHERE kind = 'channel' and archived_at is null;