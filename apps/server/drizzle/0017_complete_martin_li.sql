CREATE TABLE "campaign_asset_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" varchar(48) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_asset_folders" ADD CONSTRAINT "campaign_asset_folders_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_folders_campaign_name_idx" ON "campaign_asset_folders" USING btree ("campaign_id","name");--> statement-breakpoint
CREATE INDEX "asset_folders_campaign_idx" ON "campaign_asset_folders" USING btree ("campaign_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_folder_id_campaign_asset_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."campaign_asset_folders"("id") ON DELETE set null ON UPDATE no action;