ALTER TABLE "chat_messages" ADD COLUMN "client_message_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "request_digest" varchar(64);
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_retry_scope_idx" ON "chat_messages" USING btree ("campaign_id", "sender_id", "client_message_id");
--> statement-breakpoint
ALTER TABLE "dice_rolls" ADD COLUMN "request_id" uuid;
--> statement-breakpoint
ALTER TABLE "dice_rolls" ADD COLUMN "request_digest" varchar(64);
--> statement-breakpoint
CREATE UNIQUE INDEX "dice_retry_scope_idx" ON "dice_rolls" USING btree ("campaign_id", "user_id", "request_id");
