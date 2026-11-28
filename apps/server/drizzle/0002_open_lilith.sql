ALTER TABLE "campaign_invitations" ADD COLUMN "uses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_invitations" ADD COLUMN "max_uses" integer DEFAULT 7 NOT NULL;